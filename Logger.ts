import { LogLevel } from './types';

export class Logger {
    private level: LogLevel;
    private prefix: string;

    constructor(level: LogLevel = 'info', prefix: string = '[SDK]') {
        this.level = level;
        this.prefix = prefix;
    }

    private shouldLog(level: LogLevel): boolean {
        const levels: Record<LogLevel, number> = {
            debug: 0,
            info: 1,
            warn: 2,
            error: 3
        };
        return levels[level] >= levels[this.level];
    }

    private formatMessage(level: LogLevel, message: string, ...args: any[]): void {
        if (!this.shouldLog(level)) return;

        const timestamp = new Date().toISOString();
        const formattedMessage = `${timestamp} ${this.prefix} [${level.toUpperCase()}] ${message}`;
        
        switch (level) {
            case 'debug':
                console.debug(formattedMessage, ...args);
                break;
            case 'info':
                console.info(formattedMessage, ...args);
                break;
            case 'warn':
                console.warn(formattedMessage, ...args);
                break;
            case 'error':
                console.error(formattedMessage, ...args);
                break;
        }
    }

    debug(message: string, ...args: any[]): void {
        this.formatMessage('debug', message, ...args);
    }

    info(message: string, ...args: any[]): void {
        this.formatMessage('info', message, ...args);
    }

    warn(message: string, ...args: any[]): void {
        this.formatMessage('warn', message, ...args);
    }

    error(message: string, ...args: any[]): void {
        this.formatMessage('error', message, ...args);
    }

    setLevel(level: LogLevel): void {
        this.level = level;
    }

    getLevel(): LogLevel {
        return this.level;
    }

    setPrefix(prefix: string): void {
        this.prefix = prefix;
    }
} 