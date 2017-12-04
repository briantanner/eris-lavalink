/**
 * Created by Julian & NoobLance on 25.05.2017.
 */
const Constants = require('eris').Constants;

var EventEmitter;

try {
    EventEmitter = require('eventemitter3');
} catch (err) {
    EventEmitter = require('events').EventEmitter;
}

/**
 * Represents a player connection to a lavalink node
 * @class Player
 * @extends EventEmitter
 */
class Player extends EventEmitter {
    /**
     * Player constructor
     * @param {string} id Guild ID
     * @param {Object} data Player data
     * @param {string} data.channelId The channel id of the player
     * @param {string} data.guildId The guild id of the player
     * @param {string} data.hostname The hostname of the lavalink node
     * @param {PlayerManager} data.manager The PlayerManager associated with this player
     * @param {Lavalink} data.node The Lavalink node associated with this player
     * @param {Shard} data.shard The eris shard associated with this player
     * @param {Object} [data.options] Additional passed from the user to the player
     */
    constructor(id, { hostname, guildId, channelId, shard, node, manager, options }) {
        super();
        this.id = id;
        this.node = node;
        this.hostname = hostname;
        this.guildId = guildId;
        this.channelId = channelId;
        this.manager = manager || null;
        this.options = options;
        this.ready = false;
        this.playing = false;
        this.paused = false;
        this.shard = shard;
        this.state = {};
        this.track = null;
        this.volume = null;
        this.receivedEvents = [];
        this.sendQueue = [];
        this.timestamp = Date.now();
    }

    /**
     * Check the event queue
     * @private
     */
    checkEventQueue() {
        if (this.sendQueue.length > 0) {
            let event = this.sendQueue.splice(0,1);
            this.sendEvent(event[0]);
        }
    }

    /**
     * Queue an event to be sent to Lavalink
     * @param {*} data The payload to queue
     * @private
     */
    queueEvent(data) {
        if (this.sendQueue.length > 0) {
            this.sendQueue.push(data);
        } else {
            return this.sendEvent(data);
        }
    }

    /**
     * Send a payload to Lavalink
     * @param {*} data The payload to send
     * @private
     */
    async sendEvent(data) {
        this.receivedEvents.push(data);
        this.node.send(data);
        process.nextTick(() => this.checkEventQueue());
    }

    /**
     * Connect to the Lavalink node
     * @param {Object} data The data used to connect
     * @param {string} data.guildId The guild ID to connect
     * @param {string} data.sessionId The voice connection session ID
     * @param {object} data.event The event data from the voice server update
     */
    connect(data) {
        this.emit('connect');
        this.queueEvent({
            op: 'voiceUpdate',
            guildId: data.guildId,
            sessionId: data.sessionId,
            event: data.event,
        });

        process.nextTick(() => this.emit('ready'));
    }

    /**
     * Disconnect from Lavalink
     * @param {*} [msg] An optional disconnect message
     */
    async disconnect(msg) {
        this.playing = false;
        this.queueEvent({ op: 'disconnect', guildId: this.guildId });
        this.emit('disconnect', msg);
    }

    /**
     * Play a Lavalink track
     * @param {string} track The track to play
     * @param {Object} [options] Optional options to send
     */
    play(track, options) {
        this.lastTrack = this.track;
        this.track = track;
        this.playOptions = options;

        if (this.node.draining) {
            this.state.position = 0;
            return this.manager.switchNode(this);
        }

        let payload = Object.assign({
            op: 'play',
            guildId: this.guildId,
            track: track,
        }, options);

        this.queueEvent(payload);
        this.playing = true;
        this.timestamp = Date.now();
    }

    /**
     * Stop playing
     */
    stop() {
        // if (!this.playing) {
        let data = {
            op: 'stop',
            guildId: this.guildId,
        };

        this.queueEvent(data);
        this.playing = false;
        this.lastTrack = this.track;
        this.track = null;

        // } else {
        //     console.error('already stopped playing');
        // }
    }

    /**
     * Update player state
     * @param {Object} state The state object received from Lavalink
     * @private
     */
    stateUpdate(state) {
        this.state = state;
    }

    /**
     * Used to pause/resume the player
     * @param {boolean} pause Set pause to true/false
     */
    setPause(pause) {
        this.node.send({
            op: 'pause',
            guildId: this.guildId,
            pause: pause,
        });

        this.playing = !pause;
        this.paused = pause;
    }

    /**
     * Used for seeking to a track position
     * @param {number} position The position to seek to
     */
    seek(position) {
        this.node.send({
            op: 'seek',
            guildId: this.guildId,
            position: position,
        });
    }

    /**
     * Set the volume of the player
     * @param {number} volume The volume level to set
     */
    setVolume(volume) {
        this.node.send({
            op: 'volume',
            guildId: this.guildId,
            volume: volume,
        });

        this.volume = volume;
    }

    /**
     * Called on track end
     * @param {Object} message The end reason
     * @private
     */
    onTrackEnd(message) {
        if (message.reason !== 'REPLACED') {
            this.playing = false;
            this.lastTrack = this.track;
            this.track = null;
        }
        this.emit('end', message);
    }

    /**
     * Called on track exception
     * @param {Object} message The exception encountered
     * @private
     */
    onTrackException(message) {
        this.emit('error', message);
    }

    /**
     * Called on track stuck
     * @param {Object} message The message if exists
     * @private
     */
    onTrackStuck(message) {
        this.stop();
        process.nextTick(() => this.emit('end', message));
    }

    /**
     * Switch voice channel
     * @param {string} channelId Called when switching channels
     * @param {boolean} [reactive] Used if you want the bot to switch channels
     */
    switchChannel(channelId, reactive) {
        if(this.channelId === channelId) {
            return;
        }

        this.channelId = channelId;
        if (reactive === true) {
            this.updateVoiceState(channelId);
        }
    }

    getTimestamp() {
        return Date.now() - this.timestamp;
    }

    /**
     * Update the bot's voice state
     * @param {boolean} selfMute Whether the bot muted itself or not (audio sending is unaffected)
     * @param {boolean} selfDeaf Whether the bot deafened itself or not (audio receiving is unaffected)
     */
    updateVoiceState(channelId, selfMute, selfDeaf) {
        if (this.shard.sendWS) {
            this.shard.sendWS(Constants.GatewayOPCodes.VOICE_STATE_UPDATE, {
                guild_id: this.id === 'call' ? null : this.id,
                channel_id: channelId || null,
                self_mute: !!selfMute,
                self_deaf: !!selfDeaf,
            });
        }
    }
}

module.exports = Player;
