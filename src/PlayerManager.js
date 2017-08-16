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

    removeNode(host) {
        let node = this.nodes.get(host);
        if (!host) return;
        node.destroy();
        this.nodes.delete(host);
        this.onDisconnect(node);
    }

    onError(node, err) {
        this.client.emit(err);
    }

    onDisconnect(node, msg) {
        let players = this.filter(player => player.node.host === node.host);
        for (let player of players) {
            this.movePlayer(player);
        }
    }

    movePlayer(player) {
        let { guildId, channelId, lastTrack } = player,
            position = (player.state.position || 0) + (this.options.reconnectThreshold || 2000);

        this.delete(guildId);
        player.updateVoiceState(null);

        process.nextTick(() => {
            this.join(guildId, channelId, null, player).then(player => {
                player.emit('reconnect');
                player.play(lastTrack, { startTime: position });
                this.set(guildId, player);
            })
            .catch(err => {
                player.emit('disconnect', err);
                player.disconnect();
            });
        });
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
                if (payload.op === 4 && payload.d.channel_id === null) {
                    this.delete(payload.d.guild_id);
                }
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

    async join(guildId, channelId, options, player) {
        options = options || {};

        player = player || this.get(guildId);
        if (this.has(guildId)) {
            player.switchChannel(channelId);
            return Promise.resolve(player);
        }

        if (player) {
            player.updateVoiceState(channelId);
        }

        let region = this.getRegionFromData(options.region || 'us');
        let node = await this.findIdealNode(region);

        if (!node) {
            return Promise.reject('No available voice nodes.');
        }

        return new Promise((res, rej) => {
            this.pendingGuilds[guildId] = {
                channelId: channelId,
                options: options || {},
                player: player || null,
                node: node,
                res: res,
                rej: rej,
                timeout: setTimeout(() => {
                    node.send({ op: 'disconnect', guildId: guildId });
                    delete this.pendingGuilds[guildId];
                    rej(new Error('Voice connection timeout'));
                }, 10000),
            };

            node.send({
                op: 'connect',
                guildId: guildId,
                channelId: channelId,
            });
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
        let nodes = [...this.nodes.values()].filter(node => !node.draining && node.ws && node.connected);

        nodes = nodes.sort((a, b) => {
            let aload = a.stats.cpu ? (a.stats.cpu.systemLoad / a.stats.cpu.cores) * 100 : 0,
                bload = b.stats.cpu ? (b.stats.cpu.systemLoad / b.stats.cpu.cores) * 100 : 0;
            return aload - bload;
        });
        return nodes[0];
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

            player = this.pendingGuilds[data.guild_id].player;

            if (player) {
                player.sessionId = data.sessionId;
                player.hostname = this.pendingGuilds[data.guild_id].hostname;
                player.node = this.pendingGuilds[data.guild_id].node;
                player.event = data;
                this.set(data.guild_id, player);
            }

            player = player || this.add(new this.baseObject(data.guild_id, {
                shard: data.shard,
                guildId: data.guild_id,
                sessionId: data.session_id,
                channelId: this.pendingGuilds[data.guild_id].channelId,
                hostname: this.pendingGuilds[data.guild_id].hostname,
                node: this.pendingGuilds[data.guild_id].node,
                event: data,
            }));

            player.connect({
                sessionId: data.session_id,
                guildId: data.guild_id,
                channelId: this.pendingGuilds[data.guild_id].channelId,
                event: {
                    endpoint: data.endpoint,
                    guild_id: data.guild_id,
                    token: data.token,
                },
            });
        }

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
        if (!endpoint) return this.options.defaultRegion || 'us';

        endpoint = endpoint.replace('vip-', '');

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
