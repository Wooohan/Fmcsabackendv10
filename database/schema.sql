-- MessengerFlow Database Schema (PostgreSQL)
-- Run this to initialize the database

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Agents table
CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('SUPER_ADMIN', 'AGENT')),
    avatar TEXT,
    status TEXT DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'busy')),
    "assignedPageIds" JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Pages table
CREATE TABLE IF NOT EXISTS pages (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT,
    "isConnected" BOOLEAN DEFAULT true,
    "accessToken" TEXT NOT NULL,
    "assignedAgentIds" JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Conversations table
CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    "pageId" TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    "customerId" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "customerAvatar" TEXT,
    "lastMessage" TEXT,
    "lastTimestamp" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    status TEXT DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'PENDING', 'RESOLVED')),
    "assignedAgentId" TEXT REFERENCES agents(id) ON DELETE SET NULL,
    "unreadCount" INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    "conversationId" TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    "senderId" TEXT NOT NULL,
    "senderName" TEXT NOT NULL,
    text TEXT NOT NULL,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    "isIncoming" BOOLEAN DEFAULT true,
    "isRead" BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Approved links table
CREATE TABLE IF NOT EXISTS links (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    category TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Approved media table
CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    type TEXT CHECK (type IN ('image', 'video')),
    "isLocal" BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Provisioning logs table
CREATE TABLE IF NOT EXISTS provisioning_logs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Campaigns table
CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    message TEXT NOT NULL,
    delay_seconds INTEGER DEFAULT 3,
    total_contacts INTEGER DEFAULT 0,
    sent_count INTEGER DEFAULT 0,
    failed_count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Safely add columns if campaigns table already existed without them
DO $$ BEGIN
    ALTER TABLE campaigns ADD COLUMN delay_seconds INTEGER DEFAULT 3;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE campaigns ADD COLUMN total_contacts INTEGER DEFAULT 0;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE campaigns ADD COLUMN sent_count INTEGER DEFAULT 0;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE campaigns ADD COLUMN failed_count INTEGER DEFAULT 0;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE campaigns ADD COLUMN status TEXT DEFAULT 'running';
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE campaigns ADD COLUMN created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE campaigns ADD COLUMN updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- Fix CHECK constraint on campaigns.status to allow all required values
DO $$ BEGIN
    ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_status_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

ALTER TABLE campaigns ADD CONSTRAINT campaigns_status_check
    CHECK (status IN ('running', 'completed', 'failed', 'cancelled'));

-- Fix CHECK constraint on campaign_messages.status
DO $$ BEGIN
    ALTER TABLE campaign_messages DROP CONSTRAINT IF EXISTS campaign_messages_status_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE campaign_messages ADD CONSTRAINT campaign_messages_status_check
        CHECK (status IN ('pending', 'sent', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Campaign messages table (tracks individual sends)
CREATE TABLE IF NOT EXISTS campaign_messages (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL,
    customer_id TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    page_id TEXT NOT NULL,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
    error_message TEXT,
    sent_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_conversations_page_timestamp
    ON conversations("pageId", "lastTimestamp" DESC);

CREATE INDEX IF NOT EXISTS idx_conversations_status
    ON conversations(status);

CREATE INDEX IF NOT EXISTS idx_conversations_assigned_agent
    ON conversations("assignedAgentId")
    WHERE "assignedAgentId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_customer
    ON conversations("customerId");

CREATE INDEX IF NOT EXISTS idx_messages_conversation_timestamp
    ON messages("conversationId", timestamp ASC);

CREATE INDEX IF NOT EXISTS idx_messages_timestamp
    ON messages(timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_messages_unread
    ON messages("conversationId", "isRead")
    WHERE "isRead" = false;

CREATE INDEX IF NOT EXISTS idx_agents_email
    ON agents(email);

CREATE INDEX IF NOT EXISTS idx_agents_status
    ON agents(status);

CREATE INDEX IF NOT EXISTS idx_pages_connected
    ON pages("isConnected")
    WHERE "isConnected" = true;

CREATE INDEX IF NOT EXISTS idx_campaigns_status
    ON campaigns(status);

CREATE INDEX IF NOT EXISTS idx_campaigns_created
    ON campaigns(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_campaign_messages_campaign
    ON campaign_messages(campaign_id);

CREATE INDEX IF NOT EXISTS idx_campaign_messages_status
    ON campaign_messages(campaign_id, status);

-- Auto-update timestamp trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
    CREATE TRIGGER update_agents_updated_at
        BEFORE UPDATE ON agents
        FOR EACH ROW
        EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TRIGGER update_pages_updated_at
        BEFORE UPDATE ON pages
        FOR EACH ROW
        EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TRIGGER update_conversations_updated_at
        BEFORE UPDATE ON conversations
        FOR EACH ROW
        EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TRIGGER update_campaigns_updated_at
        BEFORE UPDATE ON campaigns
        FOR EACH ROW
        EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
