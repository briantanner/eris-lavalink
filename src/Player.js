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
    constructor(id, { hostname, guildId, channelId, shard, node }) {
        super();
        this.id = id;
        this.node = node;
        this.hostname = hostname;
        this.guildId = guildId;
        this.channelId = channelId;
        this.ready = false;
        this.playing = false;
        this.shard = shard;
        this.state = {};
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
            op: 'connect',
            guildId: data.guildId,
            channelId: data.channelId,
        });

        this.queueEvent({
            op: 'voiceUpdate',
            guildId: data.guildId,
            sessionId: data.sessionID,
            event: data.event,
        });

        process.nextTick(() => this.emit('ready'));
    }

    async disconnect(msg) {
        console.log('==== DISCONNECTED ====');
        this.channelId = null;
        this.queueEvent({ op: 'disconnect', guildId: this.guildId });
        this.updateVoiceState();
        this.emit('disconnect', msg);
    }

    stateUpdate(state) {
        this.state = state;
    }

    play(track, options) {
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
        console.log('end');
        console.log(message);
        this.playing = false;
        this.emit('end');
    }

    onTrackException(message) {
        console.log('exception');
        console.log(message);
        this.emit('error', message);
    }

    onTrackStuck(message) {
        console.log('stuck');
        console.log(message);
        this.emit('stuck', message);
    }

    async switchChannel(channelId, reactive) {
        this.channelId = channelId;
        if (!reactive) {
            this.updateVoiceState();
        }
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
