// Test fixture for PluginWorkerHost/PluginWorkerRuntime - deliberately exercises the surfaces the
// worker-sandbox regression tests need: a real ctx.sdk.* relay call, a real fs.readFileSync
// (to prove the Permission Model does/doesn't block it depending on the path), a real
// child_process attempt, and a plain console.log (to prove capture/piping doesn't crash).
import * as fs from 'fs';

export async function main(mission: string, input: any, ctx: any): Promise<any> {
  switch (input?.action) {
    case 'echo':
      return ctx.sdk.call('test.echo', input.payload);

    case 'readFile': {
      try {
        const content = fs.readFileSync(input.path, 'utf8');
        return { blocked: false, content };
      } catch (e: any) {
        return { blocked: true, code: e.code, message: e.message };
      }
    }

    case 'spawnChild': {
      try {
        const { execSync } = await import('child_process');
        const out = execSync('node --version').toString();
        return { blocked: false, out };
      } catch (e: any) {
        return { blocked: true, code: e.code, message: e.message };
      }
    }

    case 'log':
      console.log('hello from fixture plugin stdout');
      console.error('hello from fixture plugin stderr');
      return 'logged';

    case 'throw':
      throw new Error('deliberate fixture failure: ' + (input.payload ?? ''));

    default:
      return { mission, input };
  }
}
