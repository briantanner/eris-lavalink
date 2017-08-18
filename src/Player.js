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

class Player extends EventEmitter {
    constructor(id, { hostname, guildId, channelId, shard, node, manager }) {
        super();
        this.id = id;
        this.node = node;
        this.hostname = hostname;
        this.guildId = guildId;
        this.channelId = channelId;
        this.manager = manager || null;
        this.ready = false;
        this.playing = false;
        this.shard = shard;
        this.state = {};
        this.track = null;
        // this.region = region;
        this.receivedEvents = [];
        this.sendQueue = [];
    }

    checkEventQueue() {
        if (this.sendQueue.length > 0) {
            this.sendEvent(this.sendQueue[0]);
        }
    }

    queueEvent(data) {
        if (this.sendQueue.length > 0) {
            this.sendQueue.push(data);
        } else {
            return this.sendEvent(data);
        }
    }

    async sendEvent(data) {
        this.receivedEvents.push(data);
        this.node.send(data);
        process.nextTick(() => this.checkEventQueue());
    }

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

    async disconnect(msg) {
        this.playing = false;
        this.queueEvent({ op: 'disconnect', guildId: this.guildId });
        this.emit('disconnect', msg);
    }

    stateUpdate(state) {
        this.state = state;
    }

    play(track, options) {
        this.lastTrack = track;
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

    stop() {
        // if (!this.playing) {
        let data = {
            op: 'stop',
            guildId: this.guildId,
        };

        this.queueEvent(data);
        this.playing = false;
        // } else {
        //     console.error('already stopped playing');
        // }
    }

    setPause(pause) {
        this.node.send({
            op: 'pause',
            guildId: this.guildId,
            pause: pause,
        });
    }

    seek(position) {
        this.node.send({
            op: 'seek',
            guildId: this.guildId,
            position: position,
        });
    }

    setVolume(volume) {
        this.node.send({
            op: 'volume',
            guildId: this.guildId,
            volume: volume,
        });
    }

    onTrackEnd(message) {
        this.playing = false;
        this.emit('end', message);
    }

    onTrackException(message) {
        this.emit('error', message);
    }

    onTrackStuck(message) {
        this.play(this.lastTrack, { position: (this.state.position || 0) + 2000 });
        this.emit('stuck', message);
    }

    async switchChannel(channelId) {
        this.channelId = channelId;
    }

    getTimestamp() {
        return Date.now() - this.timestamp;
    }

    /**
     * Update the bot's voice state
     * @arg {Boolean} selfMute Whether the bot muted itself or not (audio sending is unaffected)
     * @arg {Boolean} selfDeaf Whether the bot deafened itself or not (audio receiving is unaffected)
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
