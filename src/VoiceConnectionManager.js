/**
 * Created by Julian & NoobLance on 25.05.2017.
 * DISCLAIMER: We reuse a lot of eris code, since we only need to do small modifications to enable our code to work
 */
const Collection = require('eris').Collection;
const VoiceNode = require('./VoiceNode');
const Player = require('./Player');

/**
 * Drop in Replacement for the eris voice connection manager
 */
class VoiceConnectionManager extends Collection {
    /**
     *
     * @param {Object} options Options for stuff
     */
    constructor(client, nodes, options) {
        super(Player);

        this.client = client;
        this.nodes = new Map();
        this.pendingGuilds = {};
        this.options = options;

        for (let node of nodes) {
            this.createNode(node, options);
        }
    }

    createNode(nodeOptions, options) {
        let node = new VoiceNode({
            host: nodeOptions.host,
            region: nodeOptions.region,
            numShards: options.numShards,
            userId: options.userId,
        });

        node.on('error', this.onError.bind(this, node));
        node.on('disconnect', this.onDisconnect.bind(this, node));
        node.on('message', this.onMessage.bind(this, node));

        this.nodes.set(nodeOptions.host, node);
    }

    onError(node, err) {
        console.log(err);
    }

    onDisconnect(node, msg) {
        console.log('Disconnected from voice node');
        if (msg) {
            console.log(msg);
        }
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
                if (!shard) return;

                const payload = JSON.parse(message.message);

                return shard.sendWS(payload.op, payload.d);
            }
            case 'playerUpdate': {
                let connection = this.get(message.guildId);
                if (!connection) return;

                return connection.stateUpdate(message.state);
            }
            case 'event': {
                let connection = this.get(message.guildId);
                if (!connection) return;

                switch (message.type) {
                    case 'TrackEndEvent':
                        return connection.onTrackEnd(message);
                    case 'TrackExceptionEvent':
                        return connection.onTrackException(message);
                    case 'TrackStuckEvent':
                        return connection.onTrackStuck(message);
                    default:
                        return connection.emit('warn', `Unexpected event type: ${message.type}`);
                }
            }
        }
    }

    async join(guildID, channelID, options) {
        return new Promise((res, rej) => {
            console.log(guildID);
            let connection = this.get(guildID);
            if (connection) {
                connection.switchChannel(channelID);
                res(connection);
            }
            this.pendingGuilds[guildID] = {
                channelID: channelID,
                options: options || {},
                res: res,
                rej: rej,
                timeout: setTimeout(() => {
                    delete this.pendingGuilds[guildID];
                    rej(new Error('Voice connection timeout'));
                }, 10000),
            };
        });
    }

    async leave(guildID) {
        let connection = this.get(guildID);
        if (!connection) {
            return;
        }
        connection.disconnect();
        this.remove(connection);
        let data = {
            t: 'voiceDisconnect',
            d: {
                guild_id: guildID,
                channel_id: connection.channelID,
                node_id: `${connection.region}:${connection.nodeID}`,
            }
        };
        await this.client.publishAsync(`${this.prefix}`, JSON.stringify(data));
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

        let connection = this.get(data.guild_id);
        if (!connection) {
            if (!this.pendingGuilds[data.guild_id]) {
                return;
            }

            let region = this.getRegionFromData(data.endpoint);
            let voiceNode = await this.findIdealNode(region);

            connection = this.add(new this.baseObject(data.guild_id, {
                shard: data.shard,
                guildID: data.guild_id,
                sessionID: data.session_id,
                channelID: this.pendingGuilds[data.guild_id].channelID,
                hostname: this.pendingGuilds[data.guild_id].hostname,
                node: voiceNode,
                event: data,
            }));

            connection.connect({
                sessionID: data.session_id,
                guildID: data.guild_id,
                channelID: this.pendingGuilds[data.guild_id].channelID,
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
            connection = this.get(data.guild_id);
            if (!this.pendingGuilds[data.guild_id]) {
                if (connection) {
                    connection.removeListener('ready', readyHandler);
                }
                return;
            }
            connection.removeListener('ready', readyHandler);
            this.pendingGuilds[data.guild_id].rej(new Error('Disconnected'));
            delete this.pendingGuilds[data.guild_id];
        };

        let readyHandler = () => {
            connection = this.get(data.guild_id);
            if (!this.pendingGuilds[data.guild_id]) {
                if (connection) {
                    connection.removeListener('disconnect', disconnectHandler);
                }
                return;
            }
            connection.removeListener('disconnect', disconnectHandler);
            this.pendingGuilds[data.guild_id].res(connection);
            delete this.pendingGuilds[data.guild_id];
        };

        connection.once('ready', readyHandler).once('disconnect', disconnectHandler);
    }

    getRegionFromData(endpoint) {
        console.log(endpoint);
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
        return 'eu';
    }
}

module.exports = VoiceConnectionManager;
