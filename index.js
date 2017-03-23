'use strict';

const LRU = require('lru-cache');
const CachePolicy = require('http-cache-semantics');

module.exports = class Cache {
    constructor(options = {}) {
        this._busyTimeout = options.busyTimeout || 2000;
        this._errorTimeout = options.errorTimeout || 200;

        this._storage = options.storage || new LRU({
            max: options.size || 500*1024*1024, // 500MB
            length(obj) {
                return obj.cost;
            },
            dispose: (url, cached) => {
                if (cached && !cached.temp && cached.policy) {
                    cached.promise.then(res => {
                        this._putInColdStorage(url, res, cached);
                    });
                }
            },
            stale:false, // errors must expire
            maxAge: options.maxAge || 24*3600*1000,
        });

        this._CachePolicy = options.CachePolicy || CachePolicy;
        this._coldStorage = options.coldStorage;
    }

    async getCached(url, request, onCacheMissCallback) {
        if (!url || !request || !onCacheMissCallback) throw Error("Bad cache args");

        const cached = this._storage.get(url);

        if (cached) {
            if (cached.temp) {
                await cached.promise;
                return this.getCached(url, request, onCacheMissCallback);
            }
            if (!cached.policy || cached.policy.satisfiesWithoutRevalidation(request)) {
                const res = await cached.promise;
                if (cached.policy) {
                    this._putInColdStorage(url, res, cached);

                    res.headers = cached.policy.responseHeaders();
                    res.headers['im2-cache'] = 'hit';
                    res.ttl = cached.policy.timeToLive();
                }
                return res;
            }
        }

        const resultPromise = this._getResult(url, request, cached, onCacheMissCallback)
        .then(({res, policy, inColdStoarge}) => {
            if (policy && res && res.headers) {
                res.headers = policy.responseHeaders(); // Headers must always be sanitized
                const timeToLive = policy.timeToLive();
                if (timeToLive) {
                    res.headers['im2-cache'] = inColdStoarge ? 'cold' : 'miss';
                    const cost = 4000 + (Buffer.isBuffer(res.body) ? res.body.byteLength : 8000);
                    this._storage.set(url, {cost, inColdStoarge, policy, promise:resultPromise}, timeToLive + Math.random()*2000); // Rand time to ease simultaneous cache misses
                } else {
                    this._storage.del(url);
                    res.headers['im2-cache'] = 'no-cache';
                }
                return res;
            } else {
                this._storage.del(url);
                throw Error(`Empty result: ${url}`);
            }
        }).catch(err => {
            // Self-referential awkwardness to avoid having a copy of the promise with uncaught error
            this._storage.set(url, {cost: 30000, isError:true, promise:resultPromise}, this._errorTimeout);
            throw err;
        });

        // thundering herd protection
        this._storage.set(url, {cost:1, temp:true, promise:resultPromise}, this._busyTimeout);
        return resultPromise;
    }

    async _getResult(url, request, cached, onCacheMissCallback) {
        if (this._coldStorage) {
            const res = await this._coldStorage.get(url).catch(err => {console.error("Ignored cold storage", err);});
            if (res) {
                // FIXME: it should read cachePolicy as well!
                const policy = new this._CachePolicy(request, res, {shared:true, ignoreCargoCult:true});
                return {res, policy, inColdStoarge: true};
            }
        }

        if (cached && cached.policy && !cached.isError) {
            const headers = cached.policy.revalidationHeaders(request);
            let res = await onCacheMissCallback(headers);

            const {policy, modified} = cached.policy.revalidatedPolicy({headers}, res);
            cached.policy = policy; // That's a bit hacky faster update, taking advantage of a shared mutable obj
            if (!modified) {
                res = await cached.promise;
            } else if (res.status === 304) {
                res = await onCacheMissCallback({});
            }
            return {res, policy};
        }

        const res = await onCacheMissCallback({});
        if (res.status === 304) {
            throw Error("Unexpected revalidation");
        }
        const policy = new this._CachePolicy(request, res, {shared:true, ignoreCargoCult:true});

        return {res, policy};
    }

    _putInColdStorage(url, res, cached) {
        if (!cached.inColdStoarge && this._coldStorage) {
            const ttl = cached.policy.timeToLive();
            if (ttl >= 3600*1000) { // don't bother if < 1h min time
                cached.inColdStoarge = true;
                this._coldStorage.set(url, res, ttl).catch(err => {
                    console.error(err);
                    cached.inColdStoarge = false;
                });
            }
        }
    }

    dump() {
        const arr = [];
        this._storage.forEach((cached, url) => {
            if (cached && !cached.temp && cached.policy) {
                arr.push(cached.promise.then(res => {
                    return this._putInColdStorage(url, res, cached);
                }));
            }
        });
        return Promise.all(arr)
    }

    purge() {
        this._storage.reset();
    }
};
