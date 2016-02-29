'use strict';

const validateHandlers = require('./utils/validateHandlers');
const passToHandlerAsync = require('./utils/passToHandlerAsync');
const _id = Symbol('id');
const _version = Symbol('version');
const _changes = Symbol('changes');
const _state = Symbol('state');

module.exports = class AbstractAggregate {

	static get handles() {
		throw new Error('handles must be overridden to return a list of handled command types');
	}

	get id() {
		return this[_id];
	}

	get version() {
		return this[_version];
	}

	get changes() {
		return this[_changes].slice(0);
	}

	get state() {
		return this[_state];
	}

	get snapshot() {
		return JSON.parse(JSON.stringify(this.state));
	}

	constructor(options) {
		if (!options) throw new TypeError('options argument required');
		if (!options.id) throw new TypeError('options.id argument required');
		if (options.events && !Array.isArray(options.events)) throw new TypeError('options.events argument, when provided, must be an Array');

		this[_id] = options.id;
		this[_version] = 0;
		this[_changes] = [];
		this[_state] = options.state || undefined;

		validateHandlers(this);

		if (options.events) {
			options.events.forEach(e => this.mutate(e));
		}
	}

	handle(command) {
		if (!command) throw new TypeError('command argument required');
		if (!command.type) throw new TypeError('command.type argument required');

		return passToHandlerAsync(this, command.type, command.payload, command.context);
	}

	/** Mutates aggregate state and increments aggregate version */
	mutate(event) {
		if (this.state) {
			this.state.mutate(event);
		}
		this[_version]++;
	}

	/**
	 * Registers new aggregate event and mutates aggregate state
	 * @param  {String} eventType 		Event name
	 * @param  {Object} eventPayload 	Event data
	 */
	emit(eventType, eventPayload) {
		if (typeof eventType !== 'string' || !eventType.length) throw new TypeError('eventType argument must be a non-empty string');

		const event = {
			aggregateId: this.id,
			version: this.version,
			type: eventType,
			payload: eventPayload
		};

		this.mutate(event);

		this[_changes].push(event);
	}
};
