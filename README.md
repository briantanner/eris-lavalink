# eris-lavalink

A [Lavalink](https://github.com/Frederikam/Lavalink) client for [eris](https://github.com/abalabahaha/eris)

## Links
- **[Documentation](https://briantanner.github.io/eris-lavalink/index.html)**
- **[Lavalink](https://github.com/Frederikam/Lavalink)**
- **[eris](https://github.com/abalabahaha/eris)**
- **[lavalink.js](https://github.com/briantanner/lavalink.js)** (discord.js port)

## Install
```
# Lavalink v2
npm install eris-lavalink

# Lavalink v1
npm install eris-lavalink@^0.1.3
```

## Implementation

Start by creating the `PlayerManager` and passing a list of nodes and optional list of regions
```js
const { PlayerManager } = require('eris-lavalink');

let nodes = [
	{ host: 'localhost', port: 8080, region: 'eu', password: 'youshallnotpass' }
];

let regions = {
	eu: ['eu', 'amsterdam', 'frankfurt', 'russia', 'hongkong', 'singapore', 'sydney'],
	us: ['us', 'brazil'],
};

if (!(client.voiceConnections instanceof PlayerManager)) {
	client.voiceConnections = new PlayerManager(client, nodes, {
		numShards: shardCount, // number of shards
		userId: userid, // the user id of the bot
		regions: regions,
		defaultRegion: 'eu',
	});
}
```

To resolve a track, use the Lavalink rest api
```js
const superagent = require('superagent');

async function resolveTracks(node, search) {
	try {
		var result = await superagent.get(`http://${node.host}:2333/loadtracks?identifier=${search}`)
			.set('Authorization', node.password)
			.set('Accept', 'application/json');
	} catch (err) {
		throw err;
	}

	if (!result) {
		throw 'Unable play that video.';
	}

	return result.body; // array of tracks resolved from lavalink
}

resolveTracks(node, 'ytsearch:the 30 second video').then(tracks => {
	if (!tracks) {
		// no tracks to play
	}
	// do something with the tracks
})
```

To join and leave voice channels, use the Lavalink client rather than using eris.
```js
// to get or join a channel
function getPlayer(channel) {
	if (!channel || !channel.guild) {
		return Promise.reject('Not a guild channel.');
	}

	let player = client.voiceConnections.get(channel.guild.id);
	if (player) {
		return Promise.resolve(player);
	}

	let options = {};
	if (channel.guild.region) {
		options.region = channel.guild.region;
	}

	return client.joinVoiceChannel(channel.id);
}

// play example
getPlayer(channel).then(player => {
	player.play(track); // track is the base64 track we get from Lavalink

	player.on('disconnect', (err) => {
		if (err) {
			// log error
		}
		// do something
	});

	player.on('error', err => {
		// log error and handle it
	});

	player.on('stuck', msg => {
		// track stuck event
	})

	player.once('end', data => {
		// REPLACED reason is emitted when playing without stopping, I ignore these to prevent skip loops
		if (data.reason && data.reason === 'REPLACED') {
			return;
		}

		// start playing the next song
	});
});

// stop example
getPlayer(channel).then(player => {
	player.stop();
	if (leave) {
		// disconnect and leave the channel
		client.leaveVoiceChannel(channel.id);
	}
})
```

**A note on pauses** 

When you pause a player, the player will be kept in a paused state until you explicitly call resume or the player is disconnected. Calls to `play` and `stop` won't clear the pause state. `player.paused` can be used to check if the player is in paused state.
