import { DB } from "https://deno.land/x/sqlite@v3.7.3/mod.ts";
import * as discord from "npm:@discordjs/core";
import { REST } from "npm:@discordjs/rest";
import { WebSocketManager } from "npm:@discordjs/ws";
import "https://deno.land/std@0.198.0/dotenv/load.ts";

const DISCORD_TOKEN = Deno.env.get("DISCORD_TOKEN");
const DISCORD_APP_ID = Deno.env.get("DISCORD_APP_ID");
const IS_FLY = Deno.env.get("FLY_ALLOC_ID");

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

  constructor(
    id: string,
    name: string,
    levels: GuildLevels | string,
  ) {
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
  db: DB;
  client: discord.Client;
  rest: REST;
  gateway: WebSocketManager;

  constructor() {
    if (!DISCORD_TOKEN || !DISCORD_APP_ID) {
      console.error(
        "No discord token / app id provided as DISCORD_TOKEN / DISCORD_APP_ID environment variable",
      );
      Deno.exit(1);
    }

    this.db = new DB(IS_FLY ? "/data/database.db" : "database.db");
    this.db.query("PRAGMA foreign_keys = ON");
    this.db.query("PRAGMA journal_mode = WAL");
    this.db.execute(`
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
    this.db.execute(`
      CREATE TABLE IF NOT EXISTS guilds (
        id TEXT PRIMARY KEY,
        name TEXT,
        levels TEXT
      )
    `);

    this.rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

    this.gateway = new WebSocketManager({
      token: DISCORD_TOKEN,
      intents: discord.GatewayIntentBits.GuildMessages |
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
      this.handle_message.bind(this),
    );
    this.gateway.connect();
  }

  async get_or_create_guild(guild_id: string): Promise<Guild | void> {
    const guild_entry = this.db.queryEntries<Schema["guild"]>(
      `SELECT * FROM guilds WHERE id = ?;`,
      [guild_id],
    )[0];

    if (!guild_entry) {
      const guild = await this.client.api.guilds.get(guild_id);
      if (!guild) return;
      this.db.queryEntries(
        `INSERT INTO guilds (id, name, levels)
        VALUES (?, ?, ?)`,
        [guild.id, guild.name, "{}"],
      );
      return new Guild(guild.id, guild.name, "{}");
    }
    return new Guild(guild_entry.id, guild_entry.name, guild_entry.levels);
  }

  async update_level(
    user_id: string,
    user_message_count: number,
    user_guild_roles: string[],
    guild_id: string,
  ) {
    const guild = await this.get_or_create_guild(guild_id);
    if (!guild) return false;

    const expected_user_role = guild.get_level_by_messages(user_message_count);
    if (!expected_user_role) return false;

    const expected_role = guild.get_level(expected_user_role);

    const user_role = user_guild_roles.find((role) =>
      role === expected_role.id
    );
    if (user_role) return false;

    await this.client.api.guilds.addRoleToMember(
      guild_id,
      user_id,
      expected_role.id,
    );

    this.db.query(
      `UPDATE users SET level = ? WHERE user_id = ? AND guild_id = ?`,
      [expected_user_role, user_id, guild_id],
    );

    return true;
  }

  async handle_command(
    message: discord.WithIntrinsicProps<
      discord.GatewayMessageCreateDispatchData
    >,
  ) {
    try {
      // !tawnybot set level [level] [target] [name]
      if (message.data.content.startsWith("!tawnybot set level")) {
        const guild = await this.get_or_create_guild(
          message.data.guild_id ?? "",
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
          message.data.guild_id ?? "",
        );
        if (!guild_info) {
          this.client.api.channels.createMessage(message.data.channel_id, {
            content: "Guild not found",
          });
          return;
        }

        const role = guild_info.roles.find((role) => role.name === name);
        if (!role) {
          this.client.api.channels.createMessage(message.data.channel_id, {
            content: "Role not found",
          });
          return;
        }

        guild.levels[level] = {
          id: role.id,
          target: parseInt(target),
          name: role.name,
        };

        this.db.query("UPDATE guilds SET levels = ? WHERE id = ?", [
          JSON.stringify(guild.levels),
          guild.id,
        ]);

        this.client.api.channels.createMessage(message.data.channel_id, {
          content:
            `Set level ${level} to ${target} messages and "${name}" role`,
        });
      }

      // !tawnybot remove level [level]
      if (message.data.content.startsWith("!tawnybot remove level")) {
        const guild = await this.get_or_create_guild(
          message.data.guild_id ?? "",
        );
        if (!guild) return;
        const level = parseInt(message.data.content.split(" ")[3]);
        if (!level) return;
        delete guild.levels[level];
        this.db.query("UPDATE guilds SET levels = ? WHERE id = ?", [
          JSON.stringify(guild.levels),
          guild.id,
        ]);
      }

      // !tawnybot list levels
      if (message.data.content.startsWith("!tawnybot list levels")) {
        const guild = await this.get_or_create_guild(
          message.data.guild_id ?? "",
        );
        if (!guild) return;
        const levels = Object.entries(guild.levels).map(([level, role]) =>
          `${level} (target: ${role.target}): ${role.name}`
        ).join("\n");
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
    message: discord.WithIntrinsicProps<
      discord.GatewayMessageCreateDispatchData
    >,
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
      let user = this.db.queryEntries(
        `INSERT INTO users (user_id, name, message_count, level, guild_id)
        VALUES (?, ?, COALESCE((SELECT message_count FROM users WHERE user_id = ?), 1), COALESCE((SELECT level FROM users WHERE user_id = ?), 0), ?)
        ON CONFLICT(user_id, guild_id) DO UPDATE SET message_count = excluded.message_count + 1
        RETURNING *;`,
        [user_id, user_name, user_id, user_id, message.data.guild_id],
      )[0] as unknown as Schema["user"];

      this.update_level(
        user.user_id,
        user.message_count,
        message.data.member?.roles ?? [],
        message.data.guild_id,
      );
    } catch (e) {
      console.error(e);
    }
  }
}

const bot = new TawnyBot();
bot.start();
