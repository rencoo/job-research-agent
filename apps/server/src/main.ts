import { applyMigrations, BusinessRepository, JobRepository, openDatabase } from "@job-research/database";
import { LocalDemoModel } from "@job-research/model-gateway";
import { buildServer } from "./app";
import { HandlerRegistry, LocalJobWorker } from "./worker";
import { createExtractionHandler, createScreeningHandler, LocalIngestionApplication, LocalOpportunityApplication, LocalProfileApplication, LocalResearchApplication } from "./business-app";

const connection = openDatabase();
applyMigrations(connection.sqlite);

const repository = new JobRepository(connection.sqlite);
const businessRepository = new BusinessRepository(connection.sqlite);
const model = new LocalDemoModel();
const profile = new LocalProfileApplication(businessRepository);
const ingestion = new LocalIngestionApplication(businessRepository, repository);
const opportunities = new LocalOpportunityApplication(businessRepository);
const research = new LocalResearchApplication(businessRepository, repository);
const registry = new HandlerRegistry()
  .register("extract-job-draft", createExtractionHandler(businessRepository, model))
  .register("screen-opportunity", createScreeningHandler(businessRepository, model));
const worker = new LocalJobWorker({ repository, registry });
const app = buildServer({
  repository,
  databaseHealth: () => {
    try {
      connection.sqlite.prepare("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  },
  workerHealth: () => worker.isRunning,
  business: { repository: businessRepository, profile, ingestion, opportunities, research },
});

const host = process.env.JRA_HOST?.trim() || "127.0.0.1";
const port = Number.parseInt(process.env.JRA_PORT ?? "4310", 10);

worker.start();
await app.listen({ host, port });

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await app.close();
  await worker.stop();
  connection.close();
};

const handleSignal = () => {
  void shutdown().then(
    () => process.exit(0),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
};

process.once("SIGINT", handleSignal);
process.once("SIGTERM", handleSignal);
