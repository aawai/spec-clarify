import type { Client, Row } from "@libsql/client";

export const ROLES = ["admin", "product", "engineer"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  admin: "管理员",
  product: "产品",
  engineer: "工程",
};

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/** Product owners clarify items; everybody may comment or ask follow-up questions. */
export function canClarify(role: Role): boolean {
  return role === "product" || role === "admin";
}

export interface User {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  disabled: boolean;
}

export interface UserWithPassword extends User {
  passwordHash: string;
}

function toUser(row: Row): UserWithPassword {
  const role = String(row.role);
  if (!isRole(role)) throw new Error(`Unknown role ${role}`);
  return {
    id: Number(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    role,
    disabled: Number(row.disabled) === 1,
    passwordHash: String(row.password_hash),
  };
}

function withoutPassword({ passwordHash: _hash, ...user }: UserWithPassword): User {
  return user;
}

export class UserStore {
  constructor(private readonly client: Client) {}

  async create(
    user: { username: string; displayName: string; role: Role; passwordHash: string },
    now = new Date(),
  ): Promise<User> {
    const result = await this.client.execute({
      sql: `INSERT INTO users (username, display_name, role, password_hash, created_at)
            VALUES (?, ?, ?, ?, ?) RETURNING *`,
      args: [user.username, user.displayName, user.role, user.passwordHash, now.toISOString()],
    });
    const row = result.rows[0];
    if (!row) throw new Error("INSERT returned no row");
    return withoutPassword(toUser(row));
  }

  async byUsername(username: string): Promise<UserWithPassword | undefined> {
    const result = await this.client.execute({
      sql: "SELECT * FROM users WHERE username = ?",
      args: [username],
    });
    const row = result.rows[0];
    return row ? toUser(row) : undefined;
  }

  async byId(id: number): Promise<UserWithPassword | undefined> {
    const result = await this.client.execute({
      sql: "SELECT * FROM users WHERE id = ?",
      args: [id],
    });
    const row = result.rows[0];
    return row ? toUser(row) : undefined;
  }

  async list(): Promise<User[]> {
    const result = await this.client.execute("SELECT * FROM users ORDER BY id");
    return result.rows.map((row) => withoutPassword(toUser(row)));
  }

  async count(): Promise<number> {
    const result = await this.client.execute("SELECT COUNT(*) AS n FROM users");
    return Number(result.rows[0]?.n ?? 0);
  }

  /** Changing the password signs the user out everywhere except `keepSession`. */
  async setPassword(id: number, passwordHash: string, keepSession?: string) {
    await this.client.batch(
      [
        { sql: "UPDATE users SET password_hash = ? WHERE id = ?", args: [passwordHash, id] },
        {
          sql: "DELETE FROM sessions WHERE user_id = ? AND token_hash IS NOT ?",
          args: [id, keepSession ?? null],
        },
      ],
      "write",
    );
  }

  async setRole(id: number, role: Role) {
    await this.client.execute({ sql: "UPDATE users SET role = ? WHERE id = ?", args: [role, id] });
  }

  /** Disabling a user also ends all of their sessions. */
  async setDisabled(id: number, disabled: boolean) {
    await this.client.batch(
      [
        { sql: "UPDATE users SET disabled = ? WHERE id = ?", args: [disabled ? 1 : 0, id] },
        ...(disabled ? [{ sql: "DELETE FROM sessions WHERE user_id = ?", args: [id] }] : []),
      ],
      "write",
    );
  }

  async createSession(userId: number, tokenHash: string, expiresAt: Date, now = new Date()) {
    await this.client.batch(
      [
        { sql: "DELETE FROM sessions WHERE expires_at <= ?", args: [now.toISOString()] },
        {
          sql: "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
          args: [tokenHash, userId, now.toISOString(), expiresAt.toISOString()],
        },
      ],
      "write",
    );
  }

  /** The signed-in user of an unexpired session; disabled users have no sessions. */
  async sessionUser(tokenHash: string, now = new Date()): Promise<User | undefined> {
    const result = await this.client.execute({
      sql: `SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
            WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.disabled = 0`,
      args: [tokenHash, now.toISOString()],
    });
    const row = result.rows[0];
    return row ? withoutPassword(toUser(row)) : undefined;
  }

  async deleteSession(tokenHash: string) {
    await this.client.execute({
      sql: "DELETE FROM sessions WHERE token_hash = ?",
      args: [tokenHash],
    });
  }
}
