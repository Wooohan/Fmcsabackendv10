import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import rateLimit from 'express-rate-limit';
import webhookRouter from './routes/webhook.js';
import apiRouter from './routes/api.js';
import { testConnection } from './services/db.js';
import logger from './utils/logger.js';
import { errorHandler } from './middleware/errorHandler.js';

dotenv.config();

const app = express();
const server = createServer(app);
const PORT = process.env.PORT || 3000;

// Socket.IO setup
const io = new SocketIOServer(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
  pingInterval: 10000,
  pingTimeout: 5000,
});

// Track connected agents: Map<socketId, { agentId, agentName }>
const connectedAgents = new Map();

// Track connected clients + agent online status
io.on('connection', (socket) => {
  logger.info('Client connected:', socket.id);

  // Agent identifies themselves after connecting
  socket.on('agent_online', async (data) => {
    const { agentId, agentName } = data || {};
    if (!agentId) return;

    connectedAgents.set(socket.id, { agentId, agentName });
    logger.info(`Agent online: ${agentName} (${agentId})`);

    // Update agent status in DB
    try {
      const { query: dbQuery } = await import('./services/db.js');
      await dbQuery(`UPDATE agents SET status = 'online' WHERE id = $1`, [agentId]);
    } catch (e) {
      logger.warn('Failed to update agent status in DB:', e.message);
    }

    // Broadcast updated agent statuses to all clients
    io.emit('agent_status_changed', { agentId, status: 'online' });
  });

  socket.on('disconnect', async () => {
    logger.info('Client disconnected:', socket.id);

    const agentInfo = connectedAgents.get(socket.id);
    if (agentInfo) {
      connectedAgents.delete(socket.id);

      // Check if this agent has other active connections
      const stillConnected = [...connectedAgents.values()].some(a => a.agentId === agentInfo.agentId);

      if (!stillConnected) {
        logger.info(`Agent offline: ${agentInfo.agentName} (${agentInfo.agentId})`);

        // Update agent status in DB
        try {
          const { query: dbQuery } = await import('./services/db.js');
          await dbQuery(`UPDATE agents SET status = 'offline' WHERE id = $1`, [agentInfo.agentId]);
        } catch (e) {
          logger.warn('Failed to update agent offline status in DB:', e.message);
        }

        // Broadcast updated agent statuses to all clients
        io.emit('agent_status_changed', { agentId: agentInfo.agentId, status: 'offline' });
      }
    }
  });
});

// Attach io to every request so routes can emit events
app.use((req, _res, next) => {
  req.io = io;
  next();
});

// Security
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 200,
  message: 'Too many requests, please try again later.',
});
app.use('/api/', limiter);

// CORS
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true,
}));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Compression
app.use(compression());

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV,
  });
});

// Routes
app.use('/webhook', webhookRouter);
app.use('/api', apiRouter);

// Error handling
app.use(errorHandler);

// 404
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Test DB connection then start
testConnection().then((ok) => {
  if (ok) {
    logger.info('PostgreSQL connection verified');
  } else {
    logger.warn('PostgreSQL connection failed — server will start but DB operations will fail');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  logger.info(`MessengerFlow Server running on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV}`);
  logger.info(`Socket.IO realtime: ACTIVE`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down');
  io.close();
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down');
  io.close();
  server.close(() => process.exit(0));
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection:', reason);
});

export default app;
