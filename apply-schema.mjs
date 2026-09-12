import pg from "pg";
import { readFileSync } from "fs";

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

await client.connect();
await client.query(readFileSync("schema.sql", "utf8"));
console.log("Schema applied");
await client.end();
