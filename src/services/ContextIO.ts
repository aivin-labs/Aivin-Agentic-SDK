import { PubSubIO } from './PubSubIO';
import type { User } from '../dto/UserDTO';
import type { Workspace, Project, MembersRequest, Member } from '../dto/WorkspaceDTO';
import type { Session, Message, MessageRequest } from '../dto/MessageDTO';
import type { Agent } from '../dto/AssistantDTO';
import type { FileShare } from '../dto/FileShareDTO';
import type { Task, TaskRequest } from '../dto/TaskDTO';
import type { NotificationRequest, Notification } from '../dto/NotificationDTO';



/**
 * ContextIO - Modular Context Management
 */
export class ContextIO {
  private static isInitialized = false;

  static init(): void {
    if (this.isInitialized) return;
    PubSubIO.init();
    this.isInitialized = true;
    console.log('[ContextIO] Initialized with modular structure');
  }

  // Shared request method for all modules
  private static async request<T>(channel: string, data: any = {}): Promise<T> {
    return await PubSubIO.request<T>(channel, data, {
      sender: 'ContextIO'
    });
  }

  // User module
  static user = {
    async getCurrentUser(): Promise<User> {
      return ContextIO.request('user:info');
    },
  };

  // Workspace module
  static workspace = {
    async getWorkspaceMembers(): Promise<Member[]> {
      return ContextIO.request('workspace:members');
    },

    async getSuitableMembers(memberRequest: MembersRequest): Promise<Member[]> {
      return ContextIO.request('workspace:suitable-members', { options: memberRequest });
    },

    async getCurrentWorkspace(): Promise<Workspace> {
      return ContextIO.request('workspace:info');
    },

    async updateMember(member: Member): Promise<Member> {
      return ContextIO.request('workspace:member-update', { member });
    }
  };
  
  static fileshare = {
    async getFileShares(): Promise<FileShare[]> {
      return ContextIO.request('fileshares:all');
    },

    async updateFileShare(fileShare: FileShare): Promise<FileShare> {
      return ContextIO.request('fileshares:update', { fileShare });
    }
  };

  // Message module
  static message = {
    async getCurrentSession(): Promise<Session> {
      return ContextIO.request('message:current-session');
    },

    async getAISharedSession(): Promise<Session> {
      return ContextIO.request('message:ai-session');
    },

    async getHistory(sessionId: string): Promise<Message[]> {
      return ContextIO.request('message:history', { sessionId });
    },

    async send(message: MessageRequest): Promise<Message> {
      return ContextIO.request('message:send', { message });
    },

    async updateSession(session: Session): Promise<Session> {
      return ContextIO.request('message:session-update', { session });
    }
  };

  static notification = {
    async push(notification: NotificationRequest): Promise<Notification> {
      return ContextIO.request('notification:push', { notification });
    }
  };

  // Assistant module
  static agent = {
    async getCurrentAgent(): Promise<Agent> {
      return ContextIO.request('assistant:current-agent');
    },

    async getWorkspaceAgents(): Promise<Agent[]> {
      return ContextIO.request('assistant:workspace-agents');
    },

    async updateInstruction(instructions: string): Promise<Agent> {
      return ContextIO.request('assistant:instruction-update', { instructions });
    }
  };

  // Project module
  static project = {
    async getProjects(): Promise<Project[]> {
      return ContextIO.request('workspace:projects');
    },

    async getTasks(projectId: string): Promise<Task[]> {
      return ContextIO.request('project:tasks', { projectId });
    },

    async setTask(task: TaskRequest): Promise<Task> {
      return ContextIO.request('project:set-task', { task });
    }
  };
} 