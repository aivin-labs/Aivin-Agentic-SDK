import Bull from 'bull';

/**
 * BullIO Data Transfer Objects
 * 
 * Chỉ chứa các interface custom của LeanEZ.
 * Các Bull native types sử dụng trực tiếp từ 'bull' package.
 */

// Custom interfaces cho BullIO methods
export interface EmitParams<T = any> {
  threadId?: string;          // ID thread để quản lý jobs
  temp?: boolean;             // Queue tạm thời
  name: string;               // Tên queue
  concurrency?: number;       // Số jobs chạy đồng thời
  data?: T;                   // Data cho job
  handler: (jobData: T) => any | Promise<any>;  // Handler xử lý job
  queueOpts?: Bull.QueueOptions;   // Cấu hình queue (Bull native)
  jobOpts?: Bull.JobOptions;       // Cấu hình job (Bull native)
}

// Submit method parameters - for simple job submission
export interface SubmitParams<T = any> {
  name: string;               // Tên queue
  data: T;                    // Data cho job
  options?: Bull.JobOptions;  // Bull native job options
}

// Listen method parameters
export interface ListenParams<T = any> {
  name: string;               // Tên queue
  handler: (jobData: T) => void | Promise<void>;  // Handler cho job data
  concurrency?: number;       // Số jobs chạy đồng thời
}

// NewInstance method parameters
export interface NewInstanceParams {
  name: string;               // Tên queue
  handler: (job: Bull.Job) => any;  // Handler xử lý job
  queueOpts?: Bull.QueueOptions;    // Cấu hình queue
  concurrency?: number;       // Số jobs chạy đồng thời
}

// Thread management (custom cho LeanEZ)
export interface ThreadInfo {
  threadId: string;
  jobs: string[];     // Array của "queueName:jobId"
  activeJobs: number;
}

// Queue statistics (custom summary)
export interface QueueStats {
  name: string;
  waiting: number;    // Jobs đang chờ
  active: number;     // Jobs đang chạy
  completed: number;  // Jobs hoàn thành
  failed: number;     // Jobs thất bại
  delayed: number;    // Jobs bị delay
  paused: boolean;    // Queue có bị pause không
}

// Error types (custom cho LeanEZ)
export class BullIOError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BullIOError';
  }
}

export class QueueNotFoundError extends BullIOError {
  constructor(message: string) {
    super(message);
    this.name = 'QueueNotFoundError';
  }
}

export class JobFailedError extends BullIOError {
  constructor(message: string, public jobId?: Bull.JobId) {
    super(message);
    this.name = 'JobFailedError';
  }
}

// Utility types
export type JobHandler<T = any> = (jobData: T) => any | Promise<any>;
export type JobProcessor = (job: Bull.Job) => any | Promise<any>; 