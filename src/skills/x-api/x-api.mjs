#!/usr/bin/env node

// x-api -- Twitter/X API v2 CLI wrapper for OpenClaw
// Uses OAuth 1.0a User Context via twitter-api-v2

import { TwitterApi } from "twitter-api-v2";

function createClient() {
  const appKey = process.env.X_API_KEY;
  const appSecret = process.env.X_API_SECRET;
  const accessToken = process.env.X_ACCESS_TOKEN;
  const accessSecret = process.env.X_ACCESS_TOKEN_SECRET;

  if (!appKey || !appSecret || !accessToken || !accessSecret) {
    console.error(
      "Error: Missing required environment variables.\n" +
        "Set X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, and X_ACCESS_TOKEN_SECRET."
    );
    process.exit(1);
  }

  return new TwitterApi({ appKey, appSecret, accessToken, accessSecret });
}

function out(data) {
  console.log(JSON.stringify(data, null, 2));
}

function usage() {
  console.log(`
x-api -- Twitter/X API v2 CLI (OAuth 1.0a User Context)

Usage:
  x-api post "tweet text"                Post a new tweet
  x-api reply <tweet_id> "text"          Reply to a tweet
  x-api read <tweet_id>                  Read a single tweet by ID
  x-api delete <tweet_id>                Delete a tweet by ID
  x-api search "query" [--max N]         Search recent tweets (default 10)
  x-api timeline [--max N]               Home timeline (default 20)
  x-api user-timeline <user_id> [--max N]  User's tweets
  x-api me                               Get authenticated user info
  x-api user <username>                  Look up user by username
  x-api dm-list [--max N]               List recent DM events
  x-api dm-send <user_id> "message"     Send a DM
  x-api like <tweet_id>                  Like a tweet
  x-api unlike <tweet_id>               Unlike a tweet
  x-api retweet <tweet_id>              Retweet
  x-api unretweet <tweet_id>            Undo retweet
  x-api followers <user_id> [--max N]   List followers
  x-api following <user_id> [--max N]   List following

Environment variables (all required):
  X_API_KEY             Consumer / App Key
  X_API_SECRET          Consumer / App Secret
  X_ACCESS_TOKEN        User Access Token
  X_ACCESS_TOKEN_SECRET User Access Token Secret

All output is JSON.
`.trim());
}

function parseFlag(args, flag, defaultVal) {
  const idx = args.indexOf(flag);
  if (idx === -1) return defaultVal;
  return args[idx + 1] ?? defaultVal;
}

const TWEET_FIELDS = {
  "tweet.fields": "created_at,author_id,conversation_id,public_metrics,lang",
  "user.fields": "name,username,verified,profile_image_url",
  expansions: "author_id",
};

const USER_FIELDS = {
  "user.fields": "created_at,description,public_metrics,profile_image_url,verified,location,url",
};

async function cmdPost(client, args) {
  const text = args[0];
  if (!text) { console.error('Usage: x-api post "tweet text"'); process.exit(1); }
  const result = await client.v2.tweet({ text });
  out(result.data);
}

async function cmdReply(client, args) {
  const [tweetId, text] = args;
  if (!tweetId || !text) { console.error('Usage: x-api reply <tweet_id> "text"'); process.exit(1); }
  const result = await client.v2.reply(text, tweetId);
  out(result.data);
}

async function cmdRead(client, args) {
  const tweetId = args[0];
  if (!tweetId) { console.error("Usage: x-api read <tweet_id>"); process.exit(1); }
  const result = await client.v2.singleTweet(tweetId, TWEET_FIELDS);
  out(result);
}

async function cmdDelete(client, args) {
  const tweetId = args[0];
  if (!tweetId) { console.error("Usage: x-api delete <tweet_id>"); process.exit(1); }
  const result = await client.v2.deleteTweet(tweetId);
  out(result.data);
}

async function cmdSearch(client, args) {
  const query = args[0];
  if (!query) { console.error('Usage: x-api search "query"'); process.exit(1); }
  const max = parseInt(parseFlag(args, "--max", "10"), 10);
  const result = await client.v2.search(query, {
    max_results: Math.min(Math.max(max, 10), 100),
    ...TWEET_FIELDS,
  });
  const tweets = [];
  for (const tweet of result) {
    tweets.push(tweet);
    if (tweets.length >= max) break;
  }
  out({ result_count: tweets.length, tweets, includes: result.includes });
}

async function cmdTimeline(client, args) {
  const max = parseInt(parseFlag(args, "--max", "20"), 10);
  const result = await client.v2.homeTimeline({
    max_results: Math.min(Math.max(max, 1), 100),
    ...TWEET_FIELDS,
  });
  const tweets = [];
  for (const tweet of result) {
    tweets.push(tweet);
    if (tweets.length >= max) break;
  }
  out({ result_count: tweets.length, tweets, includes: result.includes });
}

async function cmdUserTimeline(client, args) {
  const userId = args[0];
  if (!userId) { console.error("Usage: x-api user-timeline <user_id>"); process.exit(1); }
  const max = parseInt(parseFlag(args, "--max", "20"), 10);
  const result = await client.v2.userTimeline(userId, {
    max_results: Math.min(Math.max(max, 5), 100),
    ...TWEET_FIELDS,
  });
  const tweets = [];
  for (const tweet of result) {
    tweets.push(tweet);
    if (tweets.length >= max) break;
  }
  out({ result_count: tweets.length, tweets, includes: result.includes });
}

async function cmdMe(client) {
  const result = await client.v2.me(USER_FIELDS);
  out(result.data);
}

async function cmdUser(client, args) {
  const username = args[0];
  if (!username) { console.error("Usage: x-api user <username>"); process.exit(1); }
  const result = await client.v2.userByUsername(username.replace(/^@/, ""), USER_FIELDS);
  out(result.data);
}

async function cmdDmList(client, args) {
  const max = parseInt(parseFlag(args, "--max", "20"), 10);
  const result = await client.v2.listDmEvents({
    max_results: Math.min(Math.max(max, 1), 100),
    dm_event_fields: "id,text,created_at,sender_id,dm_conversation_id,event_type",
  });
  const events = [];
  for (const ev of result) {
    events.push(ev);
    if (events.length >= max) break;
  }
  out({ result_count: events.length, events });
}

async function cmdDmSend(client, args) {
  const [userId, text] = args;
  if (!userId || !text) { console.error('Usage: x-api dm-send <user_id> "message"'); process.exit(1); }
  const result = await client.v2.sendDmToParticipant(userId, { text });
  out(result);
}

async function cmdLike(client, args) {
  const tweetId = args[0];
  if (!tweetId) { console.error("Usage: x-api like <tweet_id>"); process.exit(1); }
  const me = await client.v2.me();
  const result = await client.v2.like(me.data.id, tweetId);
  out(result.data);
}

async function cmdUnlike(client, args) {
  const tweetId = args[0];
  if (!tweetId) { console.error("Usage: x-api unlike <tweet_id>"); process.exit(1); }
  const me = await client.v2.me();
  const result = await client.v2.unlike(me.data.id, tweetId);
  out(result.data);
}

async function cmdRetweet(client, args) {
  const tweetId = args[0];
  if (!tweetId) { console.error("Usage: x-api retweet <tweet_id>"); process.exit(1); }
  const me = await client.v2.me();
  const result = await client.v2.retweet(me.data.id, tweetId);
  out(result.data);
}

async function cmdUnretweet(client, args) {
  const tweetId = args[0];
  if (!tweetId) { console.error("Usage: x-api unretweet <tweet_id>"); process.exit(1); }
  const me = await client.v2.me();
  const result = await client.v2.unretweet(me.data.id, tweetId);
  out(result.data);
}

async function cmdFollowers(client, args) {
  const userId = args[0];
  if (!userId) { console.error("Usage: x-api followers <user_id>"); process.exit(1); }
  const max = parseInt(parseFlag(args, "--max", "20"), 10);
  const result = await client.v2.followers(userId, { max_results: Math.min(Math.max(max, 1), 1000), ...USER_FIELDS });
  out({ result_count: result.data?.length ?? 0, users: result.data });
}

async function cmdFollowing(client, args) {
  const userId = args[0];
  if (!userId) { console.error("Usage: x-api following <user_id>"); process.exit(1); }
  const max = parseInt(parseFlag(args, "--max", "20"), 10);
  const result = await client.v2.following(userId, { max_results: Math.min(Math.max(max, 1), 1000), ...USER_FIELDS });
  out({ result_count: result.data?.length ?? 0, users: result.data });
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === "--help" || command === "-h") {
    usage();
    process.exit(0);
  }

  const client = createClient();

  try {
    const commands = {
      post: cmdPost, reply: cmdReply, read: cmdRead, delete: cmdDelete,
      search: cmdSearch, timeline: cmdTimeline, "user-timeline": cmdUserTimeline,
      me: cmdMe, user: cmdUser, "dm-list": cmdDmList, "dm-send": cmdDmSend,
      like: cmdLike, unlike: cmdUnlike, retweet: cmdRetweet, unretweet: cmdUnretweet,
      followers: cmdFollowers, following: cmdFollowing,
    };

    const fn = commands[command];
    if (!fn) {
      console.error(`Unknown command: ${command}`);
      usage();
      process.exit(1);
    }
    await fn(client, args);
  } catch (err) {
    if (err.data) {
      console.error(JSON.stringify({ error: true, code: err.code, message: err.message, data: err.data, rateLimit: err.rateLimit ?? null }, null, 2));
    } else {
      console.error(JSON.stringify({ error: true, message: err.message }, null, 2));
    }
    process.exit(1);
  }
}

main();
