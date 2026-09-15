import {
  createClient,
  type Database
} from "@tursodatabase/api";
import { Secret } from "alchemy";

interface PlatformDatabase {
  DbId: string,
  Hostname: string,
  Name: string,
  Group?: string
}

export class TursoPlatformApi {
  private readonly client;
  private readonly organization;
  private readonly apiToken;

  constructor(
    organization: string,
    apiToken: Secret<string>
  ) {
    this.organization = organization;
    this.apiToken = apiToken;

    this.client = createClient({
      org: organization,
      token: async () => unwrapSecret(apiToken)
    });
  }

  async createDatabase(name: string, group: string) {
    try {
      const database = await this.client.databases.create(name, { group });
      return mapCreatedDatabase(database, group);
    } catch (error) {
      if(isStatus(error, 409)) return this.getDatabase(name);
      throw error;
    }
  }

  async getDatabase(name: string) {
    const database = await this.client.databases.get(name);
    return mapDatabase(database);
  }

  async createDatabaseToken(name: string) {
    const token = await this.client.databases.createToken(name, {
      authorization: "full-access"
    });
    return token.jwt;
  }

  async deleteDatabase(name: string) {
    try {
      await this.client.databases.delete(name);
    } catch (error) {
      if(!isStatus(error, 404)) throw error;
    }
  }
}

function mapCreatedDatabase(
  database: { id: string, hostname: string, name: string },
  group: string
) {
  return {
    DbId: database.id,
    Hostname: database.hostname,
    Name: database.name,
    Group: group
  } as PlatformDatabase;
}

function mapDatabase(database: Database) {
  return {
    DbId: database.id,
    Hostname: database.hostname,
    Name: database.name,
    Group: database.group
  } as PlatformDatabase;
}

function isStatus(error: unknown, status: number) {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { status?: unknown }).status === status
  );
}

function unwrapSecret(value: Secret<string>) {
  const unwrapped = Secret.unwrap(value);
  if(typeof unwrapped !== "string") {
    throw new Error("Expected an Alchemy secret containing a string");
  }
  return unwrapped;
}
