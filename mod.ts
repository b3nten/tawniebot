import { DB } from "https://deno.land/x/sqlite/mod.ts";
import * as discord from "npm:@discordjs/core";
import { REST } from "npm:@discordjs/rest";
import { WebSocketManager } from "npm:@discordjs/ws";

const DISCORD_TOKEN =
  "MTE0MDkxMzAxNjc3MTIwMzEzMw.GRoN9m.f-cGMrLmkPkLe1vBrDpdBO7y6UCtOryxBQSsI0";

enum Time {
  Second = 1000,
  Minute = 60000,
  Hour = 3600000,
}

enum Levels  {
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
	for(let level in Levels) {
		if(messages <= parseInt(level)) return parseInt(level);
	}
	return Levels.One;
}

const roles = {
	[Levels.One]: {
		name: "lvl 1",
		color: 0xff0000
	},
	[Levels.Two]: {
		name: "lvl 2",
		color: 0xff0000
	},
	[Levels.Three]: {
		name: "lvl 3",
		color: 0xff0000
	},
	[Levels.Four]: {
		name: "lvl 4",
		color: 0xff0000
	},
	[Levels.Five]: {
		name: "lvl 5",
		color: 0xff0000
	},
	[Levels.Six]: {
		name: "lvl 6",
		color: 0xff0000
	},
	[Levels.Seven]: {
		name: "lvl 7",
		color: 0xff0000
	},
	[Levels.Eight]: {
		name: "lvl 8",
		color: 0xff0000
	},
	[Levels.Nine]: {
		name: "lvl 9",
		color: 0xff0000
	},
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
	guilds: discord.GuildsAPI

  constructor() {
    if (!DISCORD_TOKEN) {
      console.error(
        "No discord token provided as DISCORD_TOKEN environment variable",
      );
      Deno.exit(1);
    }

    this.db = new DB("database.db");
    this.db.execute(`
  		CREATE TABLE IF NOT EXISTS users (
  		  id INTEGER PRIMARY KEY AUTOINCREMENT,
  		  name TEXT,
				user_id TEXT,
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
  }

  start() {
    this.client.on(discord.GatewayDispatchEvents.Ready, () => {
      console.log("Bot is ready");
    });
		this.client.on(discord.GatewayDispatchEvents.MessageCreate, this.handle_message.bind(this));
    this.gateway.connect();
  }

  delete_messages() {
    setTimeout(() => {
      this.delete_messages();
    }, Time.Minute * 5);
  }

	async handle_message(message: discord.WithIntrinsicProps<discord.GatewayMessageCreateDispatchData>) {
		if(!message.data.guild_id) return;
		if(message.data.author.bot) return;

		const user_id = message.data.author.id;
		const user_name = message.data.author.username;

		// get user from db
		const user = this.db.queryEntries(
			"SELECT * FROM users WHERE user_id = ?",
			[user_id]
		)[0] as unknown as User;

		// no user found, create one
		if (!user) {
			this.db.query(
				"INSERT INTO users (name, user_id, message_count, level) VALUES (?, ?, ?, ?)",
				[user_name, user_id, 1, Levels.One]
			);
			return;
		}

		// update user
		this.db.query(
			"UPDATE users SET message_count = ?, level = ? WHERE user_id = ?",
			[user.message_count + 1, get_level(user.message_count + 1), user_id]
		);

		// check if user leveled up
		if(user.level !== get_level(user.message_count + 1)) {
			// create role if it doesn't exist
			const user_role = roles[get_level(user.message_count + 1)];
			const guild = await this.guilds.get(message.data.guild_id!);
			const guild_roles = guild.roles;
			let new_role = guild_roles.find((role) => role.name === user_role.name);
			if(!new_role) {
				new_role = await this.guilds.createRole(guild.id, {
					name: user_role.name,
					color: user_role.color,
					hoist: false,
					mentionable: false,
				});
			}

			// add role to user
			await this.guilds.addRoleToMember(guild.id, user_id, new_role.id);

			// send message
			message.api.channels.createMessage(message.data.channel_id, {
				content: `<@${user_id}> leveled up to level ${get_level(user.message_count + 1)}!`
			});
		}
	}
}

const bot = new TawnyBot();
bot.start();
