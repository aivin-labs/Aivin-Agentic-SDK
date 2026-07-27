import * as grpc from '@grpc/grpc-js';
import { loadSdkTransportService } from './loadProto';

export interface InvokeRequest {
  namespace: string;
  params?: unknown;
  context?: unknown;
  timeoutMs?: number;
}

type GrpcInvokeClient = {
  Invoke: (req: any, meta: grpc.Metadata, opts: any, cb: (err: any, res: any) => void) => void;
};

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Falls back to the production endpoint when SDK_GRPC_ENDPOINT isn't set, so `ctx.sdk.*` still
 * works out of the box during local `aivin start` testing (against real production data - set
 * SDK_GRPC_ENDPOINT yourself to point at a local/dev/staging backend instead). Inside a deployed
 * container this env var is always injected by the host (DockerHelper), so this fallback never
 * applies there.
 */
const DEFAULT_ENDPOINT = 'api.aivin.cloud:50051';

let cachedClient: GrpcInvokeClient | undefined;
let cachedEndpoint: string | undefined;
let warnedDefaultEndpoint = false;

function isLocalEndpoint(endpoint: string): boolean {
  const host = endpoint.split(':')[0].toLowerCase();
  return ['localhost', '127.0.0.1', '::1', '0.0.0.0', 'host.docker.internal'].includes(host);
}

/**
 * TLS by default for anything that isn't a local/loopback/container-internal address - this
 * endpoint may now point at a real host over the public internet. Override with
 * SDK_GRPC_TLS=true|false if you need to force one way or the other (e.g. a local endpoint that
 * still requires TLS, or a remote one that's plaintext on a private network).
 */
function buildCredentials(endpoint: string): grpc.ChannelCredentials {
  const override = process.env.SDK_GRPC_TLS;
  const useTls = override ? override.toLowerCase() === 'true' : !isLocalEndpoint(endpoint);
  return useTls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
}

function getClient(endpoint: string): GrpcInvokeClient {
  if (cachedClient && cachedEndpoint === endpoint) return cachedClient;

  const ServiceCtor = loadSdkTransportService();
  cachedClient = new ServiceCtor(
    endpoint,
    buildCredentials(endpoint),
  ) as unknown as GrpcInvokeClient;
  cachedEndpoint = endpoint;
  return cachedClient;
}

/**
 * Outbound call: plugin -> Aivin host. Mirrors the backend's own
 * `GrpcTransportAdapter.invokeOnce` so the wire format matches exactly.
 */
export async function invokeHost<T = any>(request: InvokeRequest): Promise<T> {
  let endpoint = process.env.SDK_GRPC_ENDPOINT;
  if (!endpoint) {
    endpoint = DEFAULT_ENDPOINT;
    if (!warnedDefaultEndpoint) {
      warnedDefaultEndpoint = true;
      console.warn(
        `[@aivin/sdk] SDK_GRPC_ENDPOINT not set - defaulting to production (${DEFAULT_ENDPOINT}). ` +
          'Set SDK_GRPC_ENDPOINT to point at a local/dev backend instead.',
      );
    }
  }

  const client = getClient(endpoint);
  const metadata = new grpc.Metadata();
  const secret = process.env.SDK_GRPC_SECRET;
  if (secret) {
    metadata.set('authorization', `Bearer ${secret}`);
  }

  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = new Date(Date.now() + timeoutMs);

  return new Promise<T>((resolve, reject) => {
    client.Invoke(
      {
        namespace: request.namespace,
        params_json: JSON.stringify(request.params ?? {}),
        context_json: JSON.stringify(request.context ?? {}),
      },
      metadata,
      { deadline },
      (error: any, response: any) => {
        if (error) {
          reject(new Error(`gRPC invoke '${request.namespace}' failed: ${error.message || error}`));
          return;
        }
        if (!response?.success) {
          reject(
            new Error(response?.error || `gRPC invoke returned failure for ${request.namespace}`),
          );
          return;
        }
        if (!response?.data_json) {
          resolve(undefined as T);
          return;
        }
        try {
          resolve(JSON.parse(response.data_json) as T);
        } catch {
          resolve(response.data_json as T);
        }
      },
    );
  });
}
