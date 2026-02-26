---
name: x-api
description: Read and write tweets, search X/Twitter, send DMs, and manage interactions via the official X API v2 with OAuth 1.0a.
metadata: { "openclaw": { "emoji": "🐦", "requires": { "bins": ["x-api"], "env": ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"] }, "primaryEnv": "X_API_KEY" } }
---

# X / Twitter API Skill

You have access to the `x-api` CLI tool which interacts with the X (Twitter) API v2 using OAuth 1.0a user-context authentication. All output is JSON.

## Available Commands

### Posting & Managing Tweets

```bash
# Post a new tweet
x-api post "Hello from OpenClaw!"

# Reply to an existing tweet
x-api reply 1234567890 "Great point!"

# Delete your own tweet
x-api delete 1234567890
```

### Reading Tweets & Timelines

```bash
# Read a single tweet by ID
x-api read 1234567890

# Get your home timeline (reverse-chronological)
x-api timeline
x-api timeline --max 50

# Get a specific user's tweets
x-api user-timeline 1234567890
```

### Searching

```bash
# Search recent tweets
x-api search "openai lang:en"
x-api search "#ai" --max 25
```

Search supports full Twitter query syntax: `from:`, `to:`, `lang:`, hashtags, quoted phrases, `-` exclusions, `is:retweet`, `has:media`, etc.

### User Lookup

```bash
# Get your own profile info
x-api me

# Look up any user by username
x-api user elonmusk
```

### Direct Messages

```bash
# List recent DM events
x-api dm-list

# Send a DM to a user (by their numeric user ID)
x-api dm-send 1234567890 "Hey there!"
```

**Important**: `dm-send` requires the target user's numeric ID. Use `x-api user <username>` first to obtain their ID.

### Engagement

```bash
x-api like 1234567890
x-api unlike 1234567890
x-api retweet 1234567890
x-api unretweet 1234567890
```

### Social Graph

```bash
x-api followers 1234567890
x-api following 1234567890
```

## Guidelines

1. **Always confirm before posting, replying, liking, retweeting, or sending DMs.** Summarize the action and ask the user first.
2. **Tweet length limit is 280 characters.** Suggest shorter text if needed.
3. **Rate limits**: If you get a 429 error, inform the user and wait. Error output includes rate limit info.
4. **User IDs vs usernames**: Many commands need numeric user IDs. Use `x-api user <username>` to resolve.
5. **Costs**: This uses the pay-per-use X API. Each read costs ~$0.005, each post ~$0.01.
