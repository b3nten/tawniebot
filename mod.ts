import { Database } from "bun:sqlite";
import * as discord from "@discordjs/core";
import { REST } from "@discordjs/rest";
import { WebSocketManager } from "@discordjs/ws";
import { configDotenv } from "dotenv";

configDotenv();

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_APP_ID = process.env.DISCORD_APP_ID;
const IS_FLY = process.env.FLY_ALLOC_ID;

interface Schema {
  user: User;
  guild: {
    id: string;
    name: string;
    levels: string;
  };
}

interface User {
  id: number;
  name: string;
  user_id: string;
  message_count: number;
  level: string;
}

type GuildLevels = {
  [key: number]: {
    id: string;
    target: number;
    name: string;
  };
};

class Guild {
  id: string;
  name: string;
  levels: GuildLevels;

  constructor(id: string, name: string, levels: GuildLevels | string) {
    this.id = id;
    this.name = name;
    if (typeof levels === "string") {
      this.levels = JSON.parse(levels);
    } else {
      this.levels = levels;
    }
  }

  get_level(level: number) {
    return this.levels[level];
  }

  get_level_by_messages(message_count: number) {
    // need to find highest level
    let level = 0;
    for (let [key, value] of Object.entries(this.levels)) {
      if (value.target <= message_count) {
        level = Math.max(level, parseInt(key));
      }
    }
    return level;
  }
}

class TawnyBot {
  db: Database;
  client: discord.Client;
  rest: REST;
  gateway: WebSocketManager;

  constructor() {
    if (!DISCORD_TOKEN || !DISCORD_APP_ID) {
      console.error(
        "No discord token / app id provided as DISCORD_TOKEN / DISCORD_APP_ID environment variable"
      );
      process.exit(1);
    }

    this.db = new Database(IS_FLY ? "/data/database.db" : "database.db");
    this.db.query("PRAGMA foreign_keys = ON");
    this.db.query("PRAGMA journal_mode = WAL");
    this.db.run(`
  		CREATE TABLE IF NOT EXISTS users (
  		  id INTEGER PRIMARY KEY AUTOINCREMENT,
  		  name TEXT,
				user_id TEXT,
				message_count INTEGER,
				level INTEGER,
        guild_id TEXT,
        UNIQUE(user_id, guild_id)
  		)
		`);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS guilds (
        id TEXT PRIMARY KEY,
        name TEXT,
        levels TEXT
      )
    `);

    this.rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

    this.gateway = new WebSocketManager({
      token: DISCORD_TOKEN,
      intents:
        discord.GatewayIntentBits.GuildMessages |
        discord.GatewayIntentBits.MessageContent |
        discord.GatewayIntentBits.GuildMembers,
      rest: this.rest,
    });

    this.client = new discord.Client({
      rest: this.rest,
      gateway: this.gateway,
    });
  }

  start() {
    this.client.on(discord.GatewayDispatchEvents.Ready, () => {
      console.log("Bot is ready");
    });
    this.client.on(
      discord.GatewayDispatchEvents.MessageCreate,
      this.handle_message.bind(this)
    );
    this.gateway.connect();
  }

  async get_or_create_guild(guild_id: string): Promise<Guild | void> {
    const stmt = this.db.prepare<Schema["guild"], string[]>(
      `SELECT * FROM guilds WHERE id = ?;`
    );
    const guild_entry = stmt.get(guild_id);

    if (!guild_entry) {
      const guild = await this.client.api.guilds.get(guild_id);
      if (!guild) return;
      this.db.exec(
        `INSERT INTO guilds (id, name, levels)
        VALUES (?, ?, ?)`,
        [guild.id, guild.name, "{}"]
      );
      return new Guild(guild.id, guild.name, "{}");
    }
    return new Guild(guild_entry.id, guild_entry.name, guild_entry.levels);
  }

  async update_level(
    user_id: string,
    user_message_count: number,
    user_guild_roles: string[],
    guild_id: string
  ) {
    try {
      const guild = await this.get_or_create_guild(guild_id);
      if (!guild) return false;

      const expected_user_role =
        guild.get_level_by_messages(user_message_count);
      if (!expected_user_role) return false;

      const expected_role = guild.get_level(expected_user_role);

      const user_role = user_guild_roles.find(
        (role) => role === expected_role.id
      );
      if (user_role) return false;

      await this.client.api.guilds.addRoleToMember(
        guild_id,
        user_id,
        expected_role.id
      );

      this.db.exec(
        `UPDATE users SET level = ? WHERE user_id = ? AND guild_id = ?`,
        [expected_user_role, user_id, guild_id]
      );

      return true;
    } catch (e) {
      console.error(e);
      return false;
    }
  }

  async handle_command(
    message: discord.WithIntrinsicProps<discord.GatewayMessageCreateDispatchData>
  ) {
    if (message.data.member?.flags) return;
    try {
      // !tawnybot set level [level] [target] [name]
      if (message.data.content.startsWith("!tawnybot set level")) {
        const guild = await this.get_or_create_guild(
          message.data.guild_id ?? ""
        );
        if (!guild) {
          this.client.api.channels.createMessage(message.data.channel_id, {
            content: "Guild not found",
          });
          return;
        }

        const level = parseInt(message.data.content.split(" ")[3]);
        const target = message.data.content.split(" ")[4];
        const name = message.data.content.split(" ").slice(5).join(" ");
        console.log(level, target, name);
        if (!level || !target || !name) {
          this.client.api.channels.createMessage(message.data.channel_id, {
            content:
              "Invalid arguments: !tawnybot set level [level] [target] [name]",
          });
          return;
        }

        const guild_info = await this.client.api.guilds.get(
          message.data.guild_id ?? ""
        );
      }

      // !tawnybot remove level [level]
      if (message.data.content.startsWith("!tawnybot remove level")) {
        const guild = await this.get_or_create_guild(
          message.data.guild_id ?? ""
        );
        if (!guild) return;
        const level = parseInt(message.data.content.split(" ")[3]);
        if (!level) return;
        delete guild.levels[level];
        this.db.exec("UPDATE guilds SET levels = ? WHERE id = ?", [
          JSON.stringify(guild.levels),
          guild.id,
        ]);
      }

      // !tawnybot list levels
      if (message.data.content.startsWith("!tawnybot list levels")) {
        const guild = await this.get_or_create_guild(
          message.data.guild_id ?? ""
        );
        if (!guild) return;
        const levels = Object.entries(guild.levels)
          .map(
            ([level, role]) => `${level} (target: ${role.target}): ${role.name}`
          )
          .join("\n");
        console.log(levels);
        this.client.api.channels.createMessage(message.data.channel_id, {
          content: levels.length ? levels : "No levels found",
        });
      }
    } catch (e) {
      console.error(e);
      this.client.api.channels.createMessage(message.data.channel_id, {
        content: "An error occured.",
      });
    }
  }

  async handle_message(
    message: discord.WithIntrinsicProps<discord.GatewayMessageCreateDispatchData>
  ) {
    try {
      if (!message.data.guild_id) return;
      if (message.data.author.bot) return;

      const user_id = message.data.author.id;
      const user_name = message.data.author.username;

      if (message.data.content.startsWith("!tawnybot")) {
        this.handle_command(message);
        return;
      }

      // Update user
      this.db.exec(
        `INSERT INTO users (user_id, name, message_count, level, guild_id)
        VALUES (?, ?, COALESCE((SELECT message_count FROM users WHERE user_id = ?), 1), COALESCE((SELECT level FROM users WHERE user_id = ?), 0), ?)
        ON CONFLICT(user_id, guild_id) DO UPDATE SET message_count = excluded.message_count + 1
        RETURNING *;`,
        [user_id, user_name, user_id, user_id, message.data.guild_id]
      );
      const stmt = this.db.prepare<Schema["user"], string[]>(
        `SELECT * FROM users WHERE user_id = ?;`
      );
      const user = stmt.get(user_id);
      if (!user) return;

      this.update_level(
        user.user_id,
        user.message_count,
        message.data.member?.roles ?? [],
        message.data.guild_id
      );
    } catch (e) {
      console.error(e);
    }
  }
}

const bot = new TawnyBot();
bot.start();
