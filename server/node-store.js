import { DatabaseSync } from "node:sqlite";
import { Store as SharedStore } from "./model.js";
export class Store extends SharedStore {
  constructor(path = ":memory:") {
    const database = new DatabaseSync(path);
    database.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA user_version=1;",
    );
    super(database);
  }
}
