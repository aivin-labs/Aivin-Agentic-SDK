import { PubSubIO } from './PubSubIO';
import type { User, Workspace, Session, Agent, FileShare, Project, Task } from '../dto/ContextDTO';

/**
 * ContextIO - Giao tiếp với LeanEZ để lấy thông tin context
 */
export class ContextIO {
  private static isInitialized = false;

  static init(): void {
    if (this.isInitialized) return;
    PubSubIO.init();
    this.isInitialized = true;
    console.log('[ContextIO] Initialized');
  }

  // Người dùng hiện tại
  static async getCurrentUser(): Promise<User | null> {
    return this.request('context:user:current');
  }

  // Tất cả người dùng trong workspace
  static async getWorkspaceUsers(): Promise<User[]> {
    return this.request('context:users:workspace');
  }

  // Workspace hiện tại
  static async getCurrentWorkspace(): Promise<Workspace | null> {
    return this.request('context:workspace:current');
  }

  // Session hiện tại
  static async getCurrentSession(): Promise<Session | null> {
    return this.request('context:session:current');
  }

  // Session giao tiếp chung của các AI
  static async getSharedAISession(): Promise<Session | null> {
    return this.request('context:session:shared-ai');
  }

  // Agent hiện tại
  static async getCurrentAgent(): Promise<Agent | null> {
    return this.request('context:agent:current');
  }

  // Tất cả agent trong workspace
  static async getWorkspaceAgents(): Promise<Agent[]> {
    return this.request('context:agents:workspace');
  }

  // Tất cả fileshare trong workspace
  static async getWorkspaceFileShares(): Promise<FileShare[]> {
    return this.request('context:fileshares:workspace');
  }

  // Tất cả project trong workspace
  static async getWorkspaceProjects(): Promise<Project[]> {
    return this.request('context:projects:workspace');
  }

  // Lấy về task trong project
  static async getProjectTasks(projectId: string): Promise<Task[]> {
    return this.request('context:tasks:project', { projectId });
  }

  // Private request method
  private static async request<T>(channel: string, data: any = {}): Promise<T> {
    return await PubSubIO.request<T>(channel, data, {
      sender: 'ContextIO'
    });
  }
} 