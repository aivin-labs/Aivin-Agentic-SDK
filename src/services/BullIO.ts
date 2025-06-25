import Bull from 'bull';
import 'dotenv/config';
import os from 'os';
import { RedisIO } from './RedisIO';
import { 
    EmitParams, 
    SubmitParams, 
    ListenParams, 
    NewInstanceParams,
    ThreadInfo,
    QueueStats,
    BullIOError,
    QueueNotFoundError,
    JobFailedError 
} from '../dto/BullDTO';

// Global type declarations
declare global {
    var queues: Map<string, Bull.Queue>;
    var threads: Map<string, string[]>;
}

global.queues = new Map<string, Bull.Queue>();
global.threads = new Map<string, string[]>();

export class BullIO {

    static get concurrencyCount(): number {
        const loadAverage = os.loadavg()[0];
        const cpuCount = os.cpus()?.length ?? 2;

        let concurrency = Math.floor(cpuCount - loadAverage);
        concurrency = Math.max(1, concurrency);

        return concurrency;
    }

    static async newInstance(params: NewInstanceParams): Promise<Bull.Queue> {
        const { name, handler, queueOpts, concurrency } = params;
        const newQueue = new Bull(name, {
            settings: {
                stalledInterval: 30000,
            },
            ...queueOpts ?? {},
            redis: RedisIO.getConfig().url,
        });
        global.queues.set(name, newQueue);

        const finalConcurrency = concurrency ?? BullIO.concurrencyCount;

        newQueue.process(finalConcurrency, handler);
        newQueue.setMaxListeners(1000);

        newQueue.once('error', (err) => {
            console.error("newInstance error", err?.message);
        });
        newQueue.once('stalled', (job) => {
            // console.error("newInstance stalled", job);
        });

        const cleanup = () => {
            newQueue.removeAllListeners();
            process.exit(0);
        };

        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);
        return newQueue;
    }

    // just emit job for some other free server process
    static async submit(params: SubmitParams): Promise<Bull.Job> {
        const { name, data, options } = params;
        let instance: Bull.Queue | undefined = global.queues.get(name);
        if (!instance) {
            throw new QueueNotFoundError(`Queue ${name} not found`);
        }
        return instance.add(data, options);
    }
    
    // for usecase need watch change from other service
    static async listen(params: ListenParams): Promise<Bull.Queue> {
        const { name, handler, concurrency = 1 } = params;
        let handlerWrapper = (job: Bull.Job) => handler(job.data);
        let instance = await BullIO.newInstance({ 
            name, 
            handler: handlerWrapper, 
            concurrency 
        });
        return instance;
    }

    static getQueues(): Bull.Queue[] {
        return Array.from(global.queues.values());
    }

    private static addJobToThread(threadId: string, queueName: string, jobId: Bull.JobId): void {
        if (!global.threads.has(threadId)) {
            global.threads.set(threadId, []);
        }
        global.threads.get(threadId)!.push(`${queueName}:${jobId}`);
    }

    private static removeJobFromThread(threadId: string, queueName: string, jobId: Bull.JobId): void {
        const jobs = global.threads.get(threadId);
        if (jobs) {
            const index = jobs.indexOf(`${queueName}:${jobId}`);
            if (index > -1) {
                jobs.splice(index, 1);
                if (jobs.length === 0) {
                    global.threads.delete(threadId);
                }
            }
        }
    }

    private static setupThreadListeners(instance: Bull.Queue, threadId: string, jobId: Bull.JobId): void {
        const removeJobFromThread = () => {
            this.removeJobFromThread(threadId, instance.name, jobId);
        };

        instance.once(`completed:${jobId}`, removeJobFromThread);
        instance.once(`failed:${jobId}`, removeJobFromThread);
    }

    private static setupJobListeners<T>(instance: Bull.Queue, job: Bull.Job, queueName: string, temp: boolean): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            var completedListener = (j: Bull.Job, result: any) => {
                if (j.id != job.id) return;
                if (temp) global.queues.delete(queueName);
                resolve(result);
                instance.off('completed', completedListener);
            };

            var failedListener = (j: Bull.Job, e: any) => {
                reject(e.message);
                instance.off('failed', completedListener);
            }

            instance.on('completed', completedListener);
            instance.on('failed', failedListener);
        });
    }

    static async cancelRunningJobs(threadId: string): Promise<void> {
        const jobs = global.threads.get(threadId);
        if (!jobs) return;

        const cancelPromises = jobs.map((jobInfo: string) => {
            const [queueName, jobId] = jobInfo.split(':');
            const queue = global.queues.get(queueName);
            if (!queue) return null;
            
            return queue.getJob(jobId).then((job: Bull.Job | null) => 
                job ? job.moveToFailed(new Error('Job cancelled by user'), true) : null
            );
        });

        await Promise.all(cancelPromises);
        global.threads.delete(threadId);
    }

    static async emit<T>(params: EmitParams<T>): Promise<T> {
        const { name, threadId, temp = false, concurrency, data, handler, queueOpts, jobOpts } = params;
        let queueName = name;
        let instance: Bull.Queue | undefined = global.queues.get(queueName);

        if (instance == null) {
            let handlerWrapper = (job: Bull.Job) => handler(job.data);
            instance = await BullIO.newInstance({ 
                name: queueName, 
                handler: handlerWrapper, 
                queueOpts: queueOpts, 
                concurrency 
            });
        }

        let finalJobOpts = <Bull.JobOptions>{
            removeOnComplete: true,
            removeOnFail: true,
            attempts: 2,
            backoff: 1000,
            ...jobOpts ?? {},
        }

        let job = await instance.add(data, finalJobOpts);

        // Nếu có threadId thì thêm job vào map và setup listeners
        if (threadId) {
            this.addJobToThread(threadId, queueName, job.id);
            this.setupThreadListeners(instance, threadId, job.id);
        }

        return this.setupJobListeners<T>(instance, job, queueName, temp);
    }

    /**
     * Fast emit using Redis pub/sub
     */
    static async fastEmit(params: { channel: string; data: any }): Promise<void> {
        const redis = RedisIO.getClient();
        await redis.publish(params.channel, JSON.stringify(params.data));
    }

    /**
     * Fast listen using Redis pub/sub
     */
    static async fastListen(channel: string, handler: (data: any) => any): Promise<void> {
        const redis = RedisIO.getClient();
        const subscriber = redis.duplicate();
        await subscriber.connect();
        await subscriber.subscribe(channel, (message: string) => {
            try {
                const data = JSON.parse(message);
                handler(data);
            } catch {
                handler(message);
            }
        });
    }

    /**
     * Initialize Bull IO (compatibility method)
     */
    static init(): void {
        // Bull queues are initialized on-demand
        console.log('[BullIO] Bull Queue implementation initialized');
    }
} 