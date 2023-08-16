import { DB } from "https://deno.land/x/sqlite@v3.7.3/mod.ts";
import * as discord from "npm:@discordjs/core";
import { REST } from "npm:@discordjs/rest";
import { WebSocketManager } from "npm:@discordjs/ws";
import "https://deno.land/std@0.198.0/dotenv/load.ts"

const DISCORD_TOKEN = Deno.env.get("DISCORD_TOKEN");

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
  if (messages <= 0) return Levels.Zero;
  if (messages <= 1) return Levels.One;
  if (messages <= 2) return Levels.Two;
  if (messages <= 4) return Levels.Three;
  if (messages <= 8) return Levels.Four;
  if (messages <= 16) return Levels.Five;
  if (messages <= 32) return Levels.Six;
  if (messages <= 64) return Levels.Seven;
  if (messages <= 128) return Levels.Eight;
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
  guilds: discord.GuildsAPI;
  channels: discord.ChannelsAPI;

  connected_guilds = new Set<string>();

  constructor() {
    if (!DISCORD_TOKEN) {
      console.error(
        "No discord token provided as DISCORD_TOKEN environment variable",
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
				user_id TEXT UNIQUE,
				message_count INTEGER,
				level INTEGER
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

    this.guilds = new discord.GuildsAPI(this.rest);

    this.channels = new discord.ChannelsAPI(this.rest);
  }

  start() {
    this.client.on(discord.GatewayDispatchEvents.Ready, (msg) => {
      console.log(msg.data.guilds)
      console.log("Bot is ready");
    });
    this.client.on(
      discord.GatewayDispatchEvents.MessageCreate,
      this.handle_message.bind(this),
    );
    this.gateway.connect();
    // this.delete_messages();
  }

  async delete_messages() {
    for (let guild_id of this.connected_guilds) {
      const channels = await this.guilds.getChannels(guild_id);
      const channel = channels.find((channel) => channel.name === "chat");
      if (!channel) return;

      const messages = await this.channels.getMessages(channel.id, {
        limit: 100,
      });
      console.log(messages);
    }
    setTimeout(() => {
      this.delete_messages();
    }, Time.Second * 10);
  }

  async handle_message(
    message: discord.WithIntrinsicProps<
      discord.GatewayMessageCreateDispatchData
    >,
  ) {
    try {
      if (!message.data.guild_id) return;
      if (message.data.author.bot) return;

      // add guild to connected guilds
      this.connected_guilds.add(message.data.guild_id);

      const user_id = message.data.author.id;
      const user_name = message.data.author.username;

      // Update user
      let user = this.db.queryEntries(
        `INSERT INTO users (user_id, name, message_count, level)
        VALUES (?, ?, COALESCE((SELECT message_count FROM users WHERE user_id = ?), 1), COALESCE((SELECT level FROM users WHERE user_id = ?), 0))
        ON CONFLICT(user_id) DO UPDATE SET name = excluded.name, message_count = excluded.message_count + 1, level = excluded.level
        RETURNING *;`,
        [user_id, user_name, user_id, user_id],
      )[0] as unknown as User;

      // check if user level has changed
      if (
        get_level(user.message_count) !== user.level
      ) {
        this.update_level(user_id, message.data.guild_id);
      }
    } catch (e) {
      console.error(e);
    }
  }

  async update_level(user_id: string, guild_id: string) {
    const user = this.db.queryEntries(
      "SELECT * FROM users WHERE user_id = ?",
      [user_id],
    )[0] as unknown as User;

    const new_user_role = roles[get_level(user.message_count)];
    const guild = await this.guilds.get(guild_id);
    const new_role = guild.roles.find((role) =>
      role.name === new_user_role?.name
    );

    if (!new_role) return false;
    // add role to user
    await this.guilds.addRoleToMember(guild.id, user_id, new_role!.id);

    // remove old role from user
    const old_roles = guild.roles.filter((role) =>
      role.name.startsWith("lvl ") && role.name !== new_user_role?.name
    );
    for (let role of old_roles) {
      this.guilds.removeRoleFromMember(guild.id, user_id, role.id);
    }

    // update user
    this.db.query(
      "UPDATE users SET level = ? WHERE user_id = ?",
      [get_level(user.message_count), user_id],
    );
    return true;
  }
}

const bot = new TawnyBot();
bot.start();
