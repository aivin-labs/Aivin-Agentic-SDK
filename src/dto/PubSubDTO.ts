/**
 * PubSub Data Transfer Objects
 * 
 * Tham khảo từ src/notification/dto/NotificationDTO.ts và src/message/dto/MessageDTO.ts
 * Chứa các interface cần thiết cho PubSub messaging
 */

// Core PubSub Message structure
export interface PubSubMessage<T = any> {
  id: string;
  channel: string;
  data: T;
  timestamp: number;
  sender?: string;
  receiver?: string;
  type?: string;
  ttl?: number;
  metadata?: MessageMetadata;
  responseChannel?: string;
}

// Request options for PubSub operations
export interface RequestOptions {
  timeout?: number;
  retries?: number;
  sender?: string;
  receiver?: string;
  ttl?: number;
  priority?: number;
}

// Message metadata
export interface MessageMetadata {
  source?: string;
  version?: string;
  correlationId?: string;
  replyTo?: string;
  headers?: Record<string, any>;
}

// PubSub statistics removed - this is server-side monitoring

// Plugin server-side DTOs removed - client chỉ cần basic PubSub communication

// Error types
export class PubSubError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
    this.name = 'PubSubError';
  }
}

export class ChannelNotFoundError extends PubSubError {
  constructor(channel: string) {
    super(`Channel '${channel}' not found`);
    this.code = 'CHANNEL_NOT_FOUND';
  }
}

export class RequestTimeoutError extends PubSubError {
  constructor(timeout: number) {
    super(`Request timed out after ${timeout}ms`);
    this.code = 'REQUEST_TIMEOUT';
  }
} 