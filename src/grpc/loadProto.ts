import * as fs from 'fs';
import * as path from 'path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

/**
 * The single `Invoke` RPC is used in both directions on the real platform:
 * plugin -> host (outbound `sdk.call`) and host -> plugin (inbound trigger).
 * Both the client and the server need the exact same generated service definition.
 */
export function resolveProtoPath(): string {
  const candidates = [
    path.resolve(__dirname, '../proto/sdk_transport.proto'),
    path.resolve(__dirname, '../../proto/sdk_transport.proto'),
    path.resolve(process.cwd(), 'src/proto/sdk_transport.proto'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error(`sdk_transport.proto not found. Checked: ${candidates.join(', ')}`);
}

export function loadSdkTransportService(): grpc.ServiceClientConstructor {
  const protoPath = resolveProtoPath();

  const packageDefinition = protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });

  const loadedProto = grpc.loadPackageDefinition(packageDefinition) as any;
  const ServiceCtor = loadedProto?.sdktransport?.SdkTransportService;

  if (!ServiceCtor?.service) {
    throw new Error(`Failed to load SdkTransportService from ${protoPath}`);
  }

  return ServiceCtor;
}
