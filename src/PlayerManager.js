/**
 * Created by Julian & NoobLance on 25.05.2017.
 * DISCLAIMER: We reuse a lot of eris code, since we only need to do small modifications to enable our code to work
 */
const { Collection, Constants } = require('eris');
const Lavalink = require('./Lavalink');
const Player = require('./Player');

/**
 * Drop in Replacement for the eris voice connection manager
 */
class PlayerManager extends Collection {
    /**
     *
     * @param {Object} options Options for stuff
     */
    constructor(client, nodes, options) {
        super(options.player || Player);

        this.client = client;
        this.nodes = new Map();
        this.pendingGuilds = {};
        this.options = options;

        for (let node of nodes) {
            this.createNode(Object.assign({}, node, options));
        }
    }

    createNode(options) {
        let node = new Lavalink({
            host: options.host,
            region: options.region,
            numShards: options.numShards,
            userId: options.userId,
        });

        node.on('error', this.onError.bind(this, node));
        node.on('disconnect', this.onDisconnect.bind(this, node));
        node.on('message', this.onMessage.bind(this, node));

        this.nodes.set(options.host, node);
    }

    onError(node, err) {
        console.log(err);
    }

    onDisconnect(node, msg) {
        node.emit('disconnect', msg);
        node.updateVoiceState(null, false, false);
    }

    onMessage(node, message) {
        if (!message.op) return;

        switch (message.op) {
            case 'validationReq': {
                let payload = {
                    op: 'validationRes',
                    guildId: message.guildId,
                };

                if (message.channelId && message.channelId.length) {
                    let voiceChannel = this.client.getChannel(message.channelId);
                    if (voiceChannel) {
                        payload.channelId = voiceChannel.id;
                        payload.valid = true;
                    }
                } else {
                    payload.valid = true;
                }

                return node.send(payload);
            }
            case 'isConnectedReq': {
                let payload = {
                    op: 'isConnectedRes',
                    shardId: parseInt(message.shardId),
                    connected: false,
                };

                let shard = this.client.shards.get(message.shardId);
                if (shard && shard.status === 'connected') {
                    payload.connected = true;
                }

                return node.send(payload);
            }
            case 'sendWS': {
                let shard = this.client.shards.get(message.shardId);
                if (shard === undefined) return;

                const payload = JSON.parse(message.message);

                return shard.sendWS(payload.op, payload.d);
            }
            case 'playerUpdate': {
                let player = this.get(message.guildId);
                if (!player) return;

                return player.stateUpdate(message.state);
            }
            case 'event': {
                let player = this.get(message.guildId);
                if (!player) return;

                switch (message.type) {
                    case 'TrackEndEvent':
                        return player.onTrackEnd(message);
                    case 'TrackExceptionEvent':
                        return player.onTrackException(message);
                    case 'TrackStuckEvent':
                        return player.onTrackStuck(message);
                    default:
                        return player.emit('warn', `Unexpected event type: ${message.type}`);
                }
            }
        }
    }

    async join(guildId, channelId, options) {
        return new Promise((res, rej) => {
            let player = this.get(guildId);
            if (player) {
                player.switchChannel(channelId);
                res(player);
            }
            this.pendingGuilds[guildId] = {
                channelId: channelId,
                options: options || {},
                res: res,
                rej: rej,
                timeout: setTimeout(() => {
                    delete this.pendingGuilds[guildId];
                    rej(new Error('Voice connection timeout'));
                }, 10000),
            };
        });
    }

    async leave(guildId) {
        let player = this.get(guildId);
        if (!player) {
            return;
        }
        player.disconnect();
        this.remove(player);
        let data = {
            t: 'voiceDisconnect',
            d: {
                guild_id: guildId,
                channel_id: player.channelId,
                node_id: `${player.region}:${player.nodeID}`,
            }
        };
    }

    async findIdealNode() {
        let node = [...this.nodes.values()].sort((a, b) => (a.stats.playingPlayers || 0) - (b.stats.playingPlayers || 0));
        return node[0];
    }

    async voiceServerUpdate(data) {
        if (this.pendingGuilds[data.guild_id] && this.pendingGuilds[data.guild_id].timeout) {
            clearTimeout(this.pendingGuilds[data.guild_id].timeout);
            this.pendingGuilds[data.guild_id].timeout = null;
        }

        let player = this.get(data.guild_id);
        if (!player) {
            if (!this.pendingGuilds[data.guild_id]) {
                return;
            }

            let region = this.getRegionFromData(data.endpoint);
            let voiceNode = await this.findIdealNode(region);

            player = this.add(new this.baseObject(data.guild_id, {
                shard: data.shard,
                guildId: data.guild_id,
                sessionID: data.session_id,
                channelId: this.pendingGuilds[data.guild_id].channelId,
                hostname: this.pendingGuilds[data.guild_id].hostname,
                node: voiceNode,
                event: data,
            }));

            player.connect({
                sessionID: data.session_id,
                guildId: data.guild_id,
                channelId: this.pendingGuilds[data.guild_id].channelId,
                event: {
                    endpoint: data.endpoint,
                    guild_id: data.guild_id,
                    token: data.token,
                },
            });
        }

        if (!this.pendingGuilds[data.guild_id] || this.pendingGuilds[data.guild_id].waiting) {
            return;
        }

        this.pendingGuilds[data.guild_id].waiting = true;

        let disconnectHandler = () => {
            player = this.get(data.guild_id);
            if (!this.pendingGuilds[data.guild_id]) {
                if (player) {
                    player.removeListener('ready', readyHandler);
                }
                return;
            }
            player.removeListener('ready', readyHandler);
            this.pendingGuilds[data.guild_id].rej(new Error('Disconnected'));
            delete this.pendingGuilds[data.guild_id];
        };

        let readyHandler = () => {
            player = this.get(data.guild_id);
            if (!this.pendingGuilds[data.guild_id]) {
                if (player) {
                    player.removeListener('disconnect', disconnectHandler);
                }
                return;
            }
            player.removeListener('disconnect', disconnectHandler);
            this.pendingGuilds[data.guild_id].res(player);
            delete this.pendingGuilds[data.guild_id];
        };

        player.once('ready', readyHandler).once('disconnect', disconnectHandler);
    }

    getRegionFromData(endpoint) {
        if (endpoint.startsWith('eu')) {
            return 'eu';
        }
        if (endpoint.startsWith('us')) {
            return 'us';
        }
        if (endpoint.startsWith('hongkong')) {
            return 'asia';
        }
        if (endpoint.startsWith('singapore')) {
            return 'asia';
        }
        if (endpoint.startsWith('russia')) {
            return 'eu';
        }
        if (endpoint.startsWith('brazil')) {
            return 'us';
        }
        if (endpoint.startsWith('sydney')) {
            return 'asia';
        }
        return this.options.defaultRegion || 'us';
    }
}

module.exports = PlayerManager;
