import { DB } from "https://deno.land/x/sqlite@v3.7.3/mod.ts";
import * as discord from "npm:@discordjs/core";
import { REST } from "npm:@discordjs/rest";
import { WebSocketManager } from "npm:@discordjs/ws";
import "https://deno.land/std@0.198.0/dotenv/load.ts"

const DISCORD_TOKEN = Deno.env.get("DISCORD_TOKEN");
const DISCORD_APP_ID = Deno.env.get("DISCORD_APP_ID");

enum Time {
  Second = 1000,
  Minute = 60000,
  Hour = 3600000,
}

enum Levels {
  Zero = 0,
  One = 1,
  Two = 2,
  Three = 3,
  Four = 4,
  Five = 5,
  Six = 6,
  Seven = 7,
  Eight = 8,
  Nine = 9,
}

function get_level(messages: number): Levels {
  if (messages === 0) return Levels.Zero;
  if (messages <= 4) return Levels.One;
  if (messages <= 8) return Levels.Two;
  if (messages <= 16) return Levels.Three;
  if (messages <= 32) return Levels.Four;
  if (messages <= 64) return Levels.Five;
  if (messages <= 128) return Levels.Six;
  if (messages <= 256) return Levels.Seven;
  if (messages <= 512) return Levels.Eight;
  return Levels.Nine;
}

const roles = {
  [Levels.Zero]: null,
  [Levels.One]: {
    name: "lvl 1",
    color: 0xfe640b,
  },
  [Levels.Two]: {
    name: "lvl 2",
    color: 0xe49320,
  },
  [Levels.Three]: {
    name: "lvl 3",
    color: 0xd20f39,
  },
  [Levels.Four]: {
    name: "lvl 4",
    color: 0x40a02b,
  },
  [Levels.Five]: {
    name: "lvl 5",
    color: 0x209fb5,
  },
  [Levels.Six]: {
    name: "lvl 6",
    color: 0x7287fd,
  },
  [Levels.Seven]: {
    name: "lvl 7",
    color: 0x2a6ef5,
  },
  [Levels.Eight]: {
    name: "lvl 8",
    color: 0x8839ef,
  },
  [Levels.Nine]: {
    name: "lvl 9",
    color: 0xea76cb,
  },
};

function date_is_two_weeks_old(date: Date): boolean {
  const two_weeks_ago = new Date();
  two_weeks_ago.setDate(two_weeks_ago.getDate() - 14);
  return date < two_weeks_ago;
}

interface User {
  id: number;
  name: string;
  user_id: string;
  message_count: number;
  level: Levels;
}

class TawnyBot {
  db: DB;
  client: discord.Client;
  rest: REST;
  gateway: WebSocketManager;

  // Store guilds in memory
  connected_guilds = new Map<string, discord.APIGuild >();

  constructor() {
    if (!DISCORD_TOKEN || !DISCORD_APP_ID) {
      console.error(
        "No discord token / app id provided as DISCORD_TOKEN / DISCORD_APP_ID environment variable",
      );
      Deno.exit(1);
    }

    this.db = new DB("database.db");
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
    // this.delete_messages();
  }

  async get_guild(guild_id: string) {
    if (this.connected_guilds.has(guild_id)) {
      return this.connected_guilds.get(guild_id);
    }
    const guild = await this.client.api.guilds.get(guild_id);
    this.connected_guilds.set(guild_id, guild);
    return guild;
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

      // Update user
      let user = this.db.queryEntries(
        `INSERT INTO users (user_id, name, message_count, level, guild_id)
        VALUES (?, ?, COALESCE((SELECT message_count FROM users WHERE user_id = ?), 1), COALESCE((SELECT level FROM users WHERE user_id = ?), 0), ?)
        ON CONFLICT(user_id, guild_id) DO UPDATE SET message_count = excluded.message_count + 1
        RETURNING *;`,
        [user_id, user_name, user_id, user_id, message.data.guild_id],
      )[0] as unknown as User;

      this.update_level(user_id, user.message_count, message.data.member?.roles ?? [], message.data.guild_id);
      
    } catch (e) {
      console.error(e);
    }
  }

  async update_level(user_id: string, user_message_count: number, user_guild_roles: string[], guild_id: string) {

    const guild = await this.get_guild(guild_id);
    if (!guild) return false;

    const expected_user_role = roles[get_level(user_message_count)];
    const current_roles = user_guild_roles.map((role_id) =>
      guild.roles.find((role) => role.id === role_id)
    ).filter((role) => role?.name.startsWith("lvl "));

    if(current_roles.length === 0 && expected_user_role === null) return false;

    // remove old roles
    for (let role of current_roles) {
      if (role?.name !== expected_user_role?.name) {
        this.client.api.guilds.removeRoleFromMember(guild_id, user_id, role?.id ?? "");
      }
    }

    // add new role
    if (expected_user_role !== null) {
      console.log(expected_user_role)
      const role = guild.roles.find((role) => role.name === expected_user_role.name);
      if (role) {
        await this.client.api.guilds.addRoleToMember(guild_id, user_id, role.id);
      }
    }

    // update user
    this.db.query(
      "UPDATE users SET level = ? WHERE user_id = ?",
      [get_level(user_message_count), user_id],
    );
    
    return true;
  }

  async delete_messages() {
    for (let [guild_id] of this.connected_guilds) {
      const channels = await this.client.api.guilds.getChannels(guild_id);
      const channel = channels.find((channel) => channel.name === "chat");
      if (!channel) return;
      const messages = await this.client.api.channels.getMessages(channel.id, {
        limit: 100,
      });
      console.log(messages);
    }
    setTimeout(() => {
      this.delete_messages();
    }, Time.Second * 10);
  }
}

const bot = new TawnyBot();
bot.start();
