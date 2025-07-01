/**
 * Notification Data Transfer Objects
 */

export interface NotificationRequest {
  sender_id: string;
  receiver_id?: string;
  type?: string;
  title: string;
  message: string;
  event?: string;
  args?: object;
  image?: string;
  channel_id?: string;
  timestamp?: number;
}

export interface Notification {
  id: string;
  sender_id: string;
  receiver_id?: string;
  type?: string;
  title: string;
  message: string;
  event?: string;
  args?: object;
  image?: string;
  channel_id?: string;
  timestamp: number;
  is_read: boolean;
  created_at: Date;
  updated_at?: Date;
} 