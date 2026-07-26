import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const supportedVersion = '0.24.1'
const weriftRoot = fileURLToPath(new URL('../node_modules/werift/', import.meta.url))
const packageJsonPath = `${weriftRoot}package.json`
const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'))

if (packageJson.version !== supportedVersion) {
  throw new Error(
    `Refusing to patch werift ${packageJson.version}; expected ${supportedVersion}`,
  )
}

const patches = [
  // `retransmissions: 0` must mean one transmission, not a 50 ms response
  // deadline. The OpenAI ICE endpoint normally answers in roughly 150–300 ms.
  {
    path: `${weriftRoot}lib/index.mjs`,
    before: `    this.triesMax = 1 + (this.retransmissions ?? RETRY_MAX);
  }
  timeoutDelay = RETRY_RTO;`,
    after: `    this.triesMax = 1 + (this.retransmissions ?? RETRY_MAX);
    if (this.retransmissions === 0) {
      this.timeoutDelay = 1e3;
    }
  }
  timeoutDelay = RETRY_RTO;`,
  },
  {
    path: `${weriftRoot}lib/ice/src/stun/transaction.js`,
    before: `        this.triesMax = 1 + (this.retransmissions ?? const_1.RETRY_MAX);
    }
    cancel() {`,
    after: `        this.triesMax = 1 + (this.retransmissions ?? const_1.RETRY_MAX);
        if (this.retransmissions === 0) {
            this.timeoutDelay = 1000;
        }
    }
    cancel() {`,
  },
  // Chromium/libwebrtc keeps USE-CANDIDATE on pings for the selected,
  // writable pair when the remote endpoint is ICE-lite. OpenAI's endpoint
  // answers un-nominated checks but did not keep the Realtime session alive.
  {
    path: `${weriftRoot}lib/index.mjs`,
    before: `          const request = this.buildRequest({
            nominate: false,
            localUsername,
            remoteUsername,
            iceControlling,
            localCandidate: nominated.localCandidate
          });`,
    after: `          const request = this.buildRequest({
            nominate: iceControlling && this.remoteIsLite,
            localUsername,
            remoteUsername,
            iceControlling,
            localCandidate: nominated.localCandidate
          });`,
  },
  {
    path: `${weriftRoot}lib/ice/src/ice.js`,
    before: `                            const request = this.buildRequest({
                                nominate: false,
                                localUsername,
                                remoteUsername,
                                iceControlling,
                                localCandidate: nominated.localCandidate,
                            });`,
    after: `                            const request = this.buildRequest({
                                nominate: iceControlling && this.remoteIsLite,
                                localUsername,
                                remoteUsername,
                                iceControlling,
                                localCandidate: nominated.localCandidate,
                            });`,
  },
  {
    path: `${weriftRoot}lib/index.mjs`,
    before: `          } catch (error) {
            if (nominated.id === this.nominated?.id) {
              log23("no stun response");
              failures++;
              this.setState("disconnected");
              break;
            }
          }
          if (failures >= CONSENT_FAILURES) {`,
    after: `          } catch (error) {
            if (nominated.id === this.nominated?.id) {
              log23("no stun response");
              failures++;
            }
          }
          if (failures >= CONSENT_FAILURES) {`,
    satisfiedBy: `          } catch (error) {
            if (nominated.id === this.nominated?.id) {
              log23("no stun response");
            }
          }
        }
      } catch (error) {
      } finally {
        clearConsentExpiry();
      }`,
  },
  {
    path: `${weriftRoot}lib/ice/src/ice.js`,
    before: `                            catch (error) {
                                if (nominated.id === this.nominated?.id) {
                                    log("no stun response");
                                    failures++;
                                    this.setState("disconnected");
                                    break;
                                }
                            }
                            if (failures >= iceBase_1.CONSENT_FAILURES) {`,
    after: `                            catch (error) {
                                if (nominated.id === this.nominated?.id) {
                                    log("no stun response");
                                    failures++;
                                }
                            }
                            if (failures >= iceBase_1.CONSENT_FAILURES) {`,
    satisfiedBy: `                            catch (error) {
                                if (nominated.id === this.nominated?.id) {
                                    log("no stun response");
                                }
                            }
                        }
                    }
                    catch (error) { }
                    finally {
                        clearConsentExpiry();
                    }`,
  },
  // RFC 7675 expires consent 30 seconds after the last valid response.
  // A fixed failure count expires too early at 4 second intervals and too
  // late at 6 second intervals, so keep an independent deadline timer.
  {
    path: `${weriftRoot}lib/index.mjs`,
    before: `      let failures = 0;
      let canceled = false;
      const cancelEvent = new AbortController();
      onCancel.once(() => {
        canceled = true;
        failures += CONSENT_FAILURES;
        cancelEvent.abort();
        this.queryConsentHandle = void 0;
      });`,
    after: `      let canceled = false;
      let consentExpiryTimer;
      const cancelEvent = new AbortController();
      const clearConsentExpiry = () => {
        if (consentExpiryTimer === void 0) return;
        clearTimeout(consentExpiryTimer);
        consentExpiryTimer = void 0;
      };
      const refreshConsentExpiry = () => {
        clearConsentExpiry();
        consentExpiryTimer = setTimeout(() => {
          consentExpiryTimer = void 0;
          if (canceled || this.state === "closed") return;
          log23("Consent to send expired");
          this.queryConsentHandle = void 0;
          this.setState("closed");
        }, 3e4);
      };
      onCancel.once(() => {
        canceled = true;
        clearConsentExpiry();
        cancelEvent.abort();
        this.queryConsentHandle = void 0;
      });
      refreshConsentExpiry();`,
  },
  {
    path: `${weriftRoot}lib/ice/src/ice.js`,
    before: `                    let failures = 0;
                    let canceled = false;
                    const cancelEvent = new AbortController();
                    onCancel.once(() => {
                        canceled = true;
                        failures += iceBase_1.CONSENT_FAILURES;
                        cancelEvent.abort();
                        this.queryConsentHandle = undefined;
                    });`,
    after: `                    let canceled = false;
                    let consentExpiryTimer;
                    const cancelEvent = new AbortController();
                    const clearConsentExpiry = () => {
                        if (consentExpiryTimer === undefined)
                            return;
                        clearTimeout(consentExpiryTimer);
                        consentExpiryTimer = undefined;
                    };
                    const refreshConsentExpiry = () => {
                        clearConsentExpiry();
                        consentExpiryTimer = setTimeout(() => {
                            consentExpiryTimer = undefined;
                            if (canceled || this.state === "closed")
                                return;
                            log("Consent to send expired");
                            this.queryConsentHandle = undefined;
                            this.setState("closed");
                        }, 30000);
                    };
                    onCancel.once(() => {
                        canceled = true;
                        clearConsentExpiry();
                        cancelEvent.abort();
                        this.queryConsentHandle = undefined;
                    });
                    refreshConsentExpiry();`,
  },
  {
    path: `${weriftRoot}lib/index.mjs`,
    before: `          if (!nominated || canceled) {
            break;
          }`,
    after: `          if (!nominated || canceled || this.state === "closed") {
            break;
          }`,
  },
  {
    path: `${weriftRoot}lib/ice/src/ice.js`,
    before: `                            if (!nominated || canceled) {
                                break;
                            }`,
    after: `                            if (!nominated || canceled || this.state === "closed") {
                                break;
                            }`,
  },
  {
    path: `${weriftRoot}lib/index.mjs`,
    before: `            nominated.responsesReceived++;
            failures = 0;
            if (this.state === "disconnected") {
              this.setState("connected");
            }
          } catch (error) {
            if (nominated.id === this.nominated?.id) {
              log23("no stun response");
              failures++;
            }
          }
          if (failures >= CONSENT_FAILURES) {
            log23("Consent to send expired");
            this.queryConsentHandle = void 0;
            this.setState("closed");
            break;
          }
        }
      } catch (error) {
      }`,
    after: `            nominated.responsesReceived++;
            if (this.state === "closed" || canceled) {
              break;
            }
            refreshConsentExpiry();
            if (this.state === "disconnected") {
              this.setState("connected");
            }
          } catch (error) {
            if (nominated.id === this.nominated?.id) {
              log23("no stun response");
            }
          }
        }
      } catch (error) {
      } finally {
        clearConsentExpiry();
      }`,
  },
  {
    path: `${weriftRoot}lib/ice/src/ice.js`,
    before: `                                nominated.responsesReceived++;
                                failures = 0;
                                if (this.state === "disconnected") {
                                    this.setState("connected");
                                }
                            }
                            catch (error) {
                                if (nominated.id === this.nominated?.id) {
                                    log("no stun response");
                                    failures++;
                                }
                            }
                            if (failures >= iceBase_1.CONSENT_FAILURES) {
                                log("Consent to send expired");
                                this.queryConsentHandle = undefined;
                                this.setState("closed");
                                break;
                            }
                        }
                    }
                    catch (error) { }`,
    after: `                                nominated.responsesReceived++;
                                if (this.state === "closed" || canceled) {
                                    break;
                                }
                                refreshConsentExpiry();
                                if (this.state === "disconnected") {
                                    this.setState("connected");
                                }
                            }
                            catch (error) {
                                if (nominated.id === this.nominated?.id) {
                                    log("no stun response");
                                }
                            }
                        }
                    }
                    catch (error) { }
                    finally {
                        clearConsentExpiry();
                    }`,
  },
  // Measure the randomized 4–6 second interval between request starts.
  // Waiting the full interval after a response added up to the 1 second
  // transaction deadline and could stretch the cadence to 7 seconds.
  {
    path: `${weriftRoot}lib/index.mjs`,
    before: `      const { localUsername, remoteUsername, iceControlling } = this;
      try {`,
    after: `      const { localUsername, remoteUsername, iceControlling } = this;
      const randomizedConsentInterval = () => CONSENT_INTERVAL * (0.8 + 0.4 * Math.random()) * 1e3;
      let nextConsentAt = Date.now() + randomizedConsentInterval();
      try {`,
  },
  {
    path: `${weriftRoot}lib/ice/src/ice.js`,
    before: `                    const { localUsername, remoteUsername, iceControlling } = this;
                    // """`,
    after: `                    const { localUsername, remoteUsername, iceControlling } = this;
                    const randomizedConsentInterval = () => iceBase_1.CONSENT_INTERVAL * (0.8 + 0.4 * Math.random()) * 1000;
                    let nextConsentAt = Date.now() + randomizedConsentInterval();
                    // """`,
  },
  {
    path: `${weriftRoot}lib/index.mjs`,
    before: `          await timers.setTimeout(
            CONSENT_INTERVAL * (0.8 + 0.4 * Math.random()) * 1e3,
            void 0,
            { signal: cancelEvent.signal }
          );
          const nominated = this.nominated;`,
    after: `          await timers.setTimeout(
            Math.max(0, nextConsentAt - Date.now()),
            void 0,
            { signal: cancelEvent.signal }
          );
          nextConsentAt = Date.now() + randomizedConsentInterval();
          const nominated = this.nominated;`,
  },
  {
    path: `${weriftRoot}lib/ice/src/ice.js`,
    before: `                            await timers.setTimeout(iceBase_1.CONSENT_INTERVAL * (0.8 + 0.4 * Math.random()) * 1000, undefined, { signal: cancelEvent.signal });
                            const nominated = this.nominated;`,
    after: `                            await timers.setTimeout(Math.max(0, nextConsentAt - Date.now()), undefined, { signal: cancelEvent.signal });
                            nextConsentAt = Date.now() + randomizedConsentInterval();
                            const nominated = this.nominated;`,
  },
]

let changed = false
for (const patch of patches) {
  const source = await readFile(patch.path, 'utf8')
  if (
    source.includes(patch.after) ||
    (patch.satisfiedBy !== undefined && source.includes(patch.satisfiedBy))
  ) {
    continue
  }
  const occurrences = source.split(patch.before).length - 1
  if (occurrences !== 1) {
    throw new Error(
      `Refusing to patch unexpected werift source ${patch.path}: expected one match, found ${occurrences}`,
    )
  }
  await writeFile(patch.path, source.replace(patch.before, patch.after))
  changed = true
}

if (changed) {
  console.log('Applied werift 0.24.1 ICE consent freshness patch')
}
