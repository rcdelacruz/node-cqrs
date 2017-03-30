'use strict';

const InMemoryBus = require('./infrastructure/InMemoryMessageBus');
const debug = require('debug')('cqrs:debug:EventStore');
const info = require('debug')('cqrs:info:EventStore');
const EventStream = require('./EventStream');

const STORAGE_METHODS = [
	'commitEvents',
	'getEvents',
	'getAggregateEvents',
	'getSagaEvents',
	'getNewId'
];
const EMITTER_METHODS = [
	'on'
];

const _storage = Symbol('storage');
const _bus = Symbol('bus');
const _emitter = Symbol('emitter');
const _validator = Symbol('validator');
const _config = Symbol('config');
const _defaults = {
	hostname: undefined,
	publishAsync: true
};

const _namedQueues = Symbol('queueHandlers');

/**
 * Validate event structure
 *
 * @param {IEvent} event
 */
function validateEvent(event) {
	if (typeof event !== 'object' || !event) throw new TypeError('event must be an Object');
	if (typeof event.type !== 'string' || !event.type.length) throw new TypeError('event.type must be a non-empty String');
	if (!event.aggregateId && !event.sagaId) throw new TypeError('either event.aggregateId or event.sagaId is required');
	if (event.sagaId && typeof event.sagaVersion === 'undefined') throw new TypeError('event.sagaVersion is required, when event.sagaId is defined');
}

/**
 * Check whether instance has all listed methods
 *
 * @param {object} instance
 * @param {...string} methodNames
 * @returns {boolean}
 */
function respondsTo(instance, ...methodNames) {
	return methodNames.findIndex(methodName => typeof instance[methodName] !== 'function') === -1;
}

/**
 * Check if emitter support named queues
 *
 * @param {object} emitter
 * @returns {boolean}
 */
function emitterSupportsQueues(emitter) {
	const emitterPrototype = Object.getPrototypeOf(emitter);
	const EmitterType = emitterPrototype.constructor;
	return EmitterType && !!EmitterType.supportsQueues;
}

/**
 * Attaches command and node fields to each event in a given array
 *
 * @param {IEvent[]} events
 * @param {{ context, sagaId, sagaVersion }} sourceCommand
 * @param {{ hostname }} eventStoreConfig
 * @returns {EventStream}
 */
function augmentEvents(events, sourceCommand = {}, eventStoreConfig) {
	if (!Array.isArray(events)) throw new TypeError('events argument must be an Array');

	const { sagaId, sagaVersion, context } = sourceCommand;
	const { hostname } = eventStoreConfig;

	const extension = {
		sagaId,
		sagaVersion,
		context: hostname ?
			Object.assign({ hostname }, context) :
			context
	};

	return EventStream.from(events, event => Object.assign({}, extension, event));
}

/**
 * CQRS Event
 * @typedef {{ type:string, aggregateId?:string, aggregateVersion?:number, sagaId?:string, sagaVersion?:number }} IEvent
 * @property {string} type
 * @property {string|number} [aggregateId]
 * @property {number} [aggregateVersion]
 * @property {string|number} [sagaId]
 * @property {number} [sagaVersion]
 */

/**
 * Event Filter
 * @typedef {{ afterEvent?: IEvent, beforeEvent?: IEvent }} IEventFilter
 * @property {IEvent} [afterEvent]
 * @property {IEvent} [beforeEvent]
 */

module.exports = class EventStore {

	/**
	 * Default configuration
	 *
	 * @type {{ hostname: string, publishAsync: boolean }}
	 * @static
	 */
	static get defaults() {
		return _defaults;
	}

	/**
	 * Configuration
	 *
	 * @type {{ hostname: string, publishAsync: boolean }}
	 * @readonly
	 */
	get config() {
		return this[_config];
	}

	/**
	 * Creates an instance of EventStore.
	 *
	 * @param {{ storage, messageBus, eventValidator, eventStoreConfig }} options
	 */
	constructor({ storage, messageBus, eventValidator, eventStoreConfig }) {
		if (!storage)
			throw new TypeError('storage argument required');
		if (!respondsTo(storage, ...STORAGE_METHODS))
			throw new TypeError(`storage does not support methods: ${STORAGE_METHODS.filter(methodName => !respondsTo(storage, methodName))}`);
		if (messageBus !== undefined && !respondsTo(messageBus, ...EMITTER_METHODS))
			throw new TypeError(`messageBus does not support methods: ${EMITTER_METHODS.filter(methodName => !respondsTo(messageBus, methodName))}`);
		if (eventValidator !== undefined && typeof eventValidator !== 'function')
			throw new TypeError('eventValidator, when provided, must be a function');

		this[_config] = Object.freeze(Object.assign({}, EventStore.defaults, eventStoreConfig));
		this[_storage] = storage;
		this[_validator] = eventValidator || validateEvent;
		this[_namedQueues] = new Map();

		if (messageBus) {
			this[_bus] = messageBus;
			this[_emitter] = messageBus;
		}
		else if (respondsTo(storage, ...EMITTER_METHODS)) {
			this[_bus] = null;
			this[_emitter] = storage;
		}
		else {
			const bus = new InMemoryBus();
			this[_bus] = bus;
			this[_emitter] = bus;
		}
	}

	/**
	 * Retrieve new ID from the storage
	 *
	 * @returns {Promise<string>}
	 */
	async getNewId() {
		return this[_storage].getNewId();
	}

	/**
	 * Retrieve all events of specific types
	 *
	 * @param {string[]} eventTypes
	 * @param {IEventFilter} [filter]
	 * @returns {Promise<EventStream>}
	 */
	async getAllEvents(eventTypes) {
		if (eventTypes && !Array.isArray(eventTypes)) throw new TypeError('eventTypes, if specified, must be an Array');

		debug(`retrieving ${eventTypes ? eventTypes.join(', ') : 'all'} events...`);

		const events = await this[_storage].getEvents(eventTypes);

		const eventStream = EventStream.from(events);
		debug(`${eventStream} retrieved`);

		return eventStream;
	}

	/**
	 * Retrieve all events of specific Aggregate
	 *
	 * @param {string|number} aggregateId
	 * @param {IEventFilter} [filter]
	 * @returns {Promise<EventStream>}
	 */
	async getAggregateEvents(aggregateId, filter) {
		if (!aggregateId) throw new TypeError('aggregateId argument required');

		debug(`retrieving event stream for aggregate ${aggregateId}...`);

		const events = await this[_storage].getAggregateEvents(aggregateId, filter);

		const eventStream = EventStream.from(events);
		debug(`${eventStream} retrieved`);

		return eventStream;
	}

	/**
	 * Retrieve events of specific Saga
	 *
	 * @param {string|number} sagaId
	 * @param {IEventFilter} filter
	 * @returns {Promise<EventStream>}
	 */
	async getSagaEvents(sagaId, filter) {
		if (!sagaId) throw new TypeError('sagaId argument required');
		if (!filter) throw new TypeError('filter argument required');
		if (!filter.beforeEvent) throw new TypeError('filter.beforeEvent argument required');
		if (filter.beforeEvent.sagaVersion === undefined) throw new TypeError('filter.beforeEvent.sagaVersion argument required');

		debug(`retrieving event stream for saga ${sagaId}, v${filter.beforeEvent.sagaVersion}...`);

		const events = await this[_storage].getSagaEvents(sagaId, filter);

		const eventStream = EventStream.from(events);
		debug(`${eventStream} retrieved`);

		return eventStream;
	}

	/**
	 * Validate events, commit to storage and publish to messageBus, if needed
	 *
	 * @param {IEvent[]} events - a set of events to commit
	 * @returns {Promise<IEvent[]>} - resolves to signed and committed events
	 */
	async commit(events, { sourceCommand } = {}) {
		if (!Array.isArray(events)) throw new TypeError('events argument must be an Array');
		if (!events.length) return events;

		const { hostname } = this.config;
		const eventStream = augmentEvents(events, sourceCommand, { hostname });

		debug(`validating ${eventStream}...`);
		eventStream.forEach(event => {
			this[_validator](event);
		});

		debug(`committing ${eventStream}...`);
		await this[_storage].commitEvents(eventStream);

		if (this[_bus]) {
			const publishEvents = () =>
				Promise.all(eventStream.map(event => this[_bus].publish(event)))
					.then(() => {
						info(`${eventStream} published`);
					}, err => {
						info(`${eventStream} publishing failed: ${err}`);
						throw err;
					});

			if (this.config.publishAsync) {
				debug(`publishing ${eventStream} asynchronously...`);
				setImmediate(publishEvents);
			}
			else {
				debug(`publishing ${eventStream} synchronously...`);
				await publishEvents();
			}
		}

		return eventStream;
	}

	/**
	 * Setup a listener for a specific event type
	 *
	 * @param {string} messageType
	 * @param {function(IEvent): any} handler
	 */
	on(messageType, handler, { queueName } = {}) {
		if (typeof messageType !== 'string' || !messageType.length) throw new TypeError('messageType argument must be a non-empty String');
		if (typeof handler !== 'function') throw new TypeError('handler argument must be a Function');

		// named queue subscriptions
		if (queueName && !emitterSupportsQueues(this[_emitter])) {
			if (!this.config.hostname)
				throw new Error(`'${messageType}' handler could not be set up, unique config.hostname is required for named queue subscriptions`);

			const handlerKey = `${queueName}:${messageType}`;
			if (this[_namedQueues].has(handlerKey))
				throw new Error(`'${handlerKey}' handler already set up on this node`);

			this[_namedQueues].set(`${queueName}:${messageType}`, handler);

			return this[_emitter].on(messageType, event => {

				if (event.context.hostname !== this.config.hostname) {
					info(`'${event.type}' committed on node '${event.context.hostname}', '${this.config.hostname}' handler will be skipped`);
					return;
				}

				handler(event);
			});
		}

		return this[_emitter].on(messageType, handler, { queueName });
	}

	/**
	 * Creates one-time subscription for one or multiple events that match a filter
	 *
	 * @param {string[]} messageTypes - Array of event type to subscribe to
	 * @param {function(IEvent):any} [handler] - Optional handler to execute for a first event received
	 * @param {function(IEvent):boolean} [filter] - Optional filter to apply before executing a handler
	 * @return {Promise<IEvent>} Resolves to first event that passes filter
	 */
	once(messageTypes, handler, filter) {
		if (!Array.isArray(messageTypes)) messageTypes = [messageTypes];
		if (messageTypes.filter(t => !t || typeof t !== 'string').length)
			throw new TypeError('messageType argument must be either a non-empty String or an Array of non-empty Strings');
		if (handler && typeof handler !== 'function')
			throw new TypeError('handler argument, when specified, must be a Function');
		if (filter && typeof filter !== 'function')
			throw new TypeError('filter argument, when specified, must be a Function');

		const emitter = this[_emitter];

		return new Promise(resolve => {

			// handler will be invoked only once,
			// even if multiple events have been emitted before subscription was destroyed
			// https://nodejs.org/api/events.html#events_emitter_removelistener_eventname_listener
			let handled = false;

			function filteredHandler(event) {
				if (filter && !filter(event)) return;
				if (handled) return;
				handled = true;

				for (const messageType of messageTypes) {
					if (typeof emitter.removeListener === 'function')
						emitter.removeListener(messageType, filteredHandler);
					else
						emitter.off(messageType, filteredHandler);
				}

				debug(`'${event.type}' received, one-time subscription to '${messageTypes.join(',')}' removed`);

				if (handler)
					handler(event);

				resolve(event);
			}

			for (const messageType of messageTypes)
				emitter.on(messageType, filteredHandler);

			debug(`set up one-time ${filter ? 'filtered subscription' : 'subscription'} to '${messageTypes.join(',')}'`);
		});
	}
};
