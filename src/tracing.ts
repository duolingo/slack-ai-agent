import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";

const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const serviceName = process.env.OTEL_SERVICE_NAME || "slack-ai-agent";

if (otlpEndpoint) {
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
    }),
    traceExporter: new OTLPTraceExporter({ url: otlpEndpoint }),
    instrumentations: [getNodeAutoInstrumentations()],
  });

  sdk.start();
}
