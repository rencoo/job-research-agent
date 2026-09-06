import { applyMigrations } from "./migrations";
import { openDatabase } from "./connection";

const connection = openDatabase();
try {
  const applied = applyMigrations(connection.sqlite);
  console.log(
    applied.length === 0
      ? `Database is current: ${connection.path}`
      : `Applied ${applied.length} migration(s): ${applied.join(", ")}`,
  );
} finally {
  connection.close();
}
