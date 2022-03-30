import zulip from 'zulip-js';
import { createHandyClient } from 'handy-redis';
import request from 'request';
import { isURL } from 'validator';
import { config as configDotEnv } from 'dotenv';
import {
  Source,
  notEmpty,
  envOr,
  envOrDie,
  Replacements,
  Replacement,
  isCommand,
  toShredder,
  chess24Rounds,
  markdownTable,
  splitGames,
  filterGames,
  markdownPre,
  regexEscape,
} from './utils';
import Koa from 'koa';
import Router from '@koa/router';
import { promisify } from 'util';
import { differenceInSeconds } from 'date-fns';
import PgnHistory from './PgnHistory';

const sleep = promisify(setTimeout);

configDotEnv();

//------------------------------------------------------------------------------
// Environment variables/config
const version = '2.0.1';
const cookie = envOrDie('PGN_MULE_COOKIE');
const publicScheme = envOrDie('PUBLIC_SCHEME');
const publicIP = envOrDie('PUBLIC_IP');
const publicPort = parseInt(envOrDie('PUBLIC_PORT'));
const slowPollRate = parseFloat(envOrDie('SLOW_POLL_RATE_SECONDS'));
const minutesInactivitySlowDown = parseFloat(
  envOrDie('MINUTES_INACTIVITY_SLOWDOWN')
);
const minutesInactivityDie = parseFloat(envOrDie('MINUTES_INACTIVITY_DIE'));
const userAgent = envOr(
  'PGN_MULE_UA',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/69.0.3497.100 Safari/537.36'
);
const maxDelaySeconds = parseInt(envOrDie('DELAY_MAX_SECONDS'));
const zulipStream = envOrDie('ZULIP_STREAM');
const zulipTopic = envOrDie('ZULIP_TOPIC');

const redisClient = createHandyClient({
  port: parseInt(envOr('REDIS_PORT', '6379')),
  password: process.env.REDIS_PASSWORD || undefined,
  db: process.env.REDIS_DB,
});

//------------------------------------------------------------------------------
// A struct to keep timeouts
const timeouts: Record<string, ReturnType<typeof setTimeout> | undefined> = {};

(async () => {
  const z = await zulip({
    username: envOrDie('ZULIP_USERNAME'),
    apiKey: envOrDie('ZULIP_API_KEY'),
    realm: envOrDie('ZULIP_REALM'),
  });

  const getSources = async () => {
    const keys = await redisClient.keys('pgnmule:*');
    console.log(`Got ${keys.length} sources: ${JSON.stringify(keys)}`);
    return (await Promise.all(keys.map((k) => redisClient.get(k))))
      .filter(notEmpty)
      .map(sourceFromJSON);
  };
  const clearAllSources = async (messageId: number) => {
    console.log(`Clearing all sources`);
    const sources = await getSources();
    sources.forEach(async (s) => {
      console.log(`Clearing source: ${s.name}`);
      await removeSource(s.name);
    });
    await react('check_mark', messageId);
    await say(`Cleared ${sources.length} sources`);
  };

  const startSources = async () => {
    (await getSources()).forEach((s) => {
      console.log(`Starting ${s.name}`);
      pollURL(s.name);
    });
  };

  const pollURL = async (name: string) => {
    const timeoutId = timeouts[name];
    if (notEmpty(timeoutId)) clearTimeout(timeoutId);
    timeouts[name] = undefined;
    const source = await getSource(name);
    if (source === undefined) return;
    request(
      {
        uri: source.url,
        headers: {
          Cookie: cookie,
          'User-Agent': userAgent,
        },
      },
      async (err, res, body) => {
        const source = await getSource(name);
        if (source === undefined) return;
        if (body && !err && res.statusCode === 200) {
          source.pgnHistory.add(body);
          const allGames = body.split('[Event').filter((g: string) => !!g);
          console.log(
            `[${name}]: Got ${allGames.length} games (${body.length} bytes)`
          );
        } else if (!body) {
          console.log(`[${name}]: Empty response`);
        } else if (res.statusCode !== 404) {
          console.log(`[${name}]: ERROR ${res.statusCode} err:${err}`);
        }
        const secondsSinceUpdated = differenceInSeconds(
          new Date(),
          source.dateLastUpdated
        );
        source.dateLastUpdated = new Date();
        await setSource(source);
        const minutes =
          differenceInSeconds(new Date(), source.dateLastPolled) / 60.0;
        if (minutes >= minutesInactivityDie) {
          console.log(`${name} removed due to inactivity`);
          say(`${name} removed due to inactivity`);
          await removeSource(name);
        } else {
          let updateFreqMillis = source.updateFreqSeconds * 1000;
          if (minutes >= minutesInactivitySlowDown) {
            updateFreqMillis = Math.max(
              source.updateFreqSeconds * 4 * 1000,
              slowPollRate * 1000
            );
            console.log(
              `New update freq: ${Math.round(updateFreqMillis / 1000)}s`
            );
            console.log(
              `Checking whether we just slowed down or not: ${secondsSinceUpdated} < ${slowPollRate} = ${
                secondsSinceUpdated < slowPollRate
              }`
            );
            console.log(
              `secondsSinceUpdate - source.updateFreqSeconds = ${Math.abs(
                secondsSinceUpdated - source.updateFreqSeconds / 1000.0
              )} | secondsSinceUpdate - slowPollRate = ${Math.abs(
                secondsSinceUpdated - slowPollRate
              )}
            Are we closer to the slow poll rate? ${
              Math.abs(
                secondsSinceUpdated - source.updateFreqSeconds / 1000.0
              ) < Math.abs(secondsSinceUpdated - slowPollRate)
            }
          `
            );
            if (
              Math.abs(
                secondsSinceUpdated - source.updateFreqSeconds / 1000.0
              ) < Math.abs(secondsSinceUpdated - slowPollRate)
            ) {
              sayOnce(
                `${name} Slowing refresh to ${updateFreqMillis / 1000} seconds`
              );
            }
          }
          timeouts[name] = setTimeout(() => pollURL(name), updateFreqMillis);
        }
      }
    );
  };

  const react = async (name: string, messageId: number) =>
    await z.reactions.add({
      message_id: messageId,
      emoji_name: name,
    });

  const removeSource = async (name: string) => {
    await redisClient.del(`pgnmule:${name}`);
  };
  const remove = async (name: string, messageId: number) => {
    await removeSource(name);
    await react('check_mark', messageId);
  };

  const setSource = async (s: Source) => {
    await redisClient.set(`pgnmule:${s.name}`, sourceToJSON(s));
  };

  const sourceFromJSON = (s: string): Source => {
    try {
      const d = JSON.parse(s);
      return {
        ...d,
        pgnHistory: PgnHistory.fromJson(d.pgnHistory, d.delaySeconds || 0),
        updateFreqSeconds: Math.max(d.updateFreqSeconds, 1),
        dateLastPolled: new Date(d.dateLastPolled),
        dateLastUpdated: new Date(d.dateLastUpdated),
      };
    } catch (e) {
      console.log(s);
      throw e;
    }
  };

  const sourceToJSON = (s: Source): string =>
    JSON.stringify({ ...s, pgnHistory: s.pgnHistory.entries });

  const getSource = async (name: string) => {
    const value = await redisClient.get(`pgnmule:${name}`);
    if (!value) return undefined;
    return sourceFromJSON(value);
  };

  const formatSource = (s: Source) =>
    [
      `\`${s.name}\``,
      `Source URL: ${s.url}`,
      `Exposed URL: ${publicScheme}://${publicIP}:${publicPort}/${s.name}`,
      `Update frequency: once every ${s.updateFreqSeconds} seconds`,
      `Delay: ${s.delaySeconds} seconds`,
    ].join('\n');

  const formatManySources = (sources: Source[]) =>
    `all of them -> ${publicScheme}://${publicIP}:${publicPort}/${sources
      .map((s) => s.name)
      .join('/')}`;

  const list = async () => {
    const sources = await getSources();
    if (!sources.length) await say('No active sources');
    else
      await say(
        markdownTable([
          ['Name', 'Destination', 'Freq', 'Delay', 'Source'],
          ...sources.map((s) => [
            s.name,
            `${publicScheme}://${publicIP}:${publicPort}/${s.name}`,
            `1/${s.updateFreqSeconds}s`,
            `${s.delaySeconds}s`,
            s.url,
          ]),
        ])
      );
  };

  const addOrSet = async (parts: string[], reactToMessageId?: number) => {
    const updateFreqSeconds = parts.length > 3 ? parseInt(parts[3]) : 10;
    const delaySeconds = parts.length > 4 ? parseInt(parts[4]) : 0;
    if (delaySeconds > maxDelaySeconds) {
      say(`Delay must be <= ${maxDelaySeconds}`);
      return;
    }
    let name = parts[1];
    let url = parts[2];
    if (url.startsWith('<')) url = url.slice(1);
    if (url.endsWith('>')) url = url.slice(0, url.length - 1);

    if (!isURL(url)) {
      say(`${url} is not a valid URL`);
      console.log(`${url} is not a valid url`);
      return;
    }
    const previous = await getSource(name);
    const source = {
      name,
      url,
      updateFreqSeconds,
      pgnHistory:
        previous?.url == url
          ? previous.pgnHistory
          : new PgnHistory([], delaySeconds),
      delaySeconds,
      dateLastPolled: new Date(),
      dateLastUpdated: new Date(),
    };
    await setSource(source);
    pollURL(name);
    if (reactToMessageId) {
      await react('check_mark', reactToMessageId);
    }
    await sleep(0.5);
    await say(formatSource(source));
    return source;
  };

  const addMany = async (parts: string[], messageId: number) => {
    parts.shift(); // Remove initial command
    let vars = parts.shift(); // Remove vars
    if (vars === undefined) return;
    const sources = await Promise.all(
      vars.split(',').map(async (x) => {
        const newParts = parts.map((p) => p.replace(/\{\}/, x));
        return await addOrSet(['add', ...newParts]);
      })
    );
    await react('check_mark', messageId);
    await say(formatManySources(sources.filter(notEmpty)));
  };

  const setReplacements = async (replacements: Replacements) => {
    await redisClient.set(
      'pgnmuleprivate:replacements',
      JSON.stringify(replacements)
    );
  };
  const getReplacements = async () => {
    const replacementsString = await redisClient.get(
      'pgnmuleprivate:replacements'
    );
    if (!notEmpty(replacementsString)) {
      return [] as Replacements;
    }
    return JSON.parse(replacementsString) as Replacements;
  };
  const replace = async (pgn: string) => {
    const replacements = await getReplacements();
    return replacements.reduce(
      (current, r) =>
        current.replace(
          new RegExp(r.regex ? r.oldContent : regexEscape(r.oldContent), 'g'),
          r.newContent
        ),
      pgn
    );
  };
  const addReplacement = async (
    messageId: number,
    replacementString: string
  ) => {
    const regex = replacementString.startsWith('r`');
    if (regex) replacementString = replacementString.substring(1);
    const [oldContent, newContent] = replacementString.split('->').map((s) =>
      s
        .trim()
        .replace(/^`+|`+$/g, '')
        .replace(/\\n/g, '\n')
    );
    const replacement: Replacement = { oldContent, newContent };
    if (regex) replacement.regex = true;
    await setReplacements([...(await getReplacements()), replacement]);
    await react('check_mark', messageId);
  };
  const addReplacements = async (messageId: number, arg: string) => {
    const replacements = arg
      .replace(/^`+|`+$/g, '')
      .split('\n')
      .map((x) => x.trim())
      .filter((x) => x.length > 0)
      .map((x) => {
        const [oldContent, newContent] = x.split('\t').map((x) => x.trim());
        return { oldContent, newContent };
      });
    await setReplacements([...(await getReplacements()), ...replacements]);
    await react('check_mark', messageId);
  };
  const listReplacements = async () => {
    await say(
      markdownTable([
        ['ID', 'From', 'To', 'Regex'],
        ...(
          await getReplacements()
        ).map((r, i) => [
          '' + i,
          markdownPre(r.oldContent),
          markdownPre(r.newContent),
          r.regex ? 'regex' : '',
        ]),
      ])
    );
  };
  const removeReplacement = async (messageId: number, indexString: string) => {
    const parts = indexString.split('-');
    const start = parseInt(parts[0]);
    const end = parseInt(parts[parts.length - 1]);
    await setReplacements(
      (await getReplacements()).filter((_, i) => i < start || i > end)
    );
    await react('check_mark', messageId);
  };

  const zulipHandler = async (msg: any) => {
    try {
      let text = msg.content.trim();
      if (text.startsWith('Reminder: ')) {
        text = text.slice(10);
      }
      console.log(`Received command: ${text}`);
      let parts = text.split(/\s+/);
      if (parts.length < 1) return;
      let command = parts[0].toLowerCase();
      if (
        isCommand(command, ['add', 'set']) &&
        parts.length > 2 &&
        parts.length < 6
      ) {
        console.log(`Processing add command ${parts}`);
        await addOrSet(parts);
      } else if (
        isCommand(command, ['addmany', 'add-many']) &&
        parts.length > 3 &&
        parts.length < 7
      ) {
        console.log(`Processing addMany command ${parts}`);
        await addMany(parts, msg.id);
      } else if (
        isCommand(command, ['remove', 'rm', 'del', 'stop']) &&
        parts.length == 2
      ) {
        console.log(`Processing remove command ${parts}`);
        await remove(parts[1], msg.id);
      } else if (isCommand(command, ['list']) && parts.length === 1) {
        console.log(`Processing list command ${parts}`);
        list();
      } else if (
        isCommand(command, ['clear-all-sources']) &&
        parts.length === 1
      ) {
        console.log(`Processing clear-all-sources command ${parts}`);
        await clearAllSources(msg.id);
      } else if (
        isCommand(command, ['replace', 'addreplacement', 'add-replacement']) &&
        parts.length > 1
      ) {
        console.log(`Processing add-replacement command ${parts}`);
        await addReplacement(msg.id, text.substr(command.length + 1));
      } else if (
        isCommand(command, [
          'replace-multiple',
          'addreplacements',
          'add-replacements',
        ]) &&
        parts.length > 1
      ) {
        console.log(`Processing add-replacements command`);
        await addReplacements(msg.id, text.substr(command.length + 1));
      } else if (
        isCommand(command, [
          'replacements',
          'listreplacements',
          'list-replacements',
        ]) &&
        parts.length === 1
      ) {
        console.log(`Processing list-replacement command ${parts}`);
        listReplacements();
      } else if (
        isCommand(command, [
          'removereplacement',
          'remove-replacement',
          'delreplacement',
          'del-replacement',
          'rmreplacement',
          'rm-replacement',
        ]) &&
        parts.length === 2
      ) {
        console.log(`Processing remove-replacement command ${parts}`);
        removeReplacement(msg.id, parts[1]);
      } else if (isCommand(command, ['version'])) {
        await say(`Version: ${version}`);
      } else {
        console.log('Unprocessed command');
      }
    } catch (e) {
      console.error(`Uncaught error: ${e}`);
    }
  };

  const say = async (text: string) =>
    await z.messages.send({
      to: zulipStream,
      type: 'stream',
      subject: zulipTopic,
      content: text,
    });

  let lastSay = '';
  const sayOnce = async (text: string) => {
    if (text != lastSay) await say(text);
    lastSay = text;
  };

  const zulipMessageLoop = async (client: any, queue: number, handler: any) => {
    let lastEventId = -1;
    while (true) {
      try {
        const res = await client.events.retrieve({
          queue_id: queue,
          last_event_id: lastEventId,
        });
        res.events.forEach(async (event: any) => {
          lastEventId = event.id;
          if (event.type == 'heartbeat') {
            // console.log('Zulip heartbeat');
          } else if (event.message) {
            if (event.message.subject == zulipTopic)
              await handler(event.message);
          } else console.log(event);
        });
      } catch (e) {
        console.error(e);
        await sleep(2000);
      }
    }
  };

  console.log('Looking for sources to start');
  await startSources();
  const app = new Koa();
  const router = new Router();

  router.get('/', (ctx, _) => {
    ctx.body = 'Hello World';
  });
  router.get('/favicon.ico', (ctx, _) => {
    ctx.throw(404);
  });
  router.get('/:names+', async (ctx, _) => {
    const names = ctx.params.names.split('/') as string[];
    const sources = await Promise.all(names.map((n) => getSource(n as string)));
    await Promise.all(
      sources.filter(notEmpty).map((s) => {
        s.dateLastPolled = new Date();
        return setSource(s);
      })
    );
    let pgns = sources
      .filter(notEmpty)
      .map((s) => s.pgnHistory.getWithDelay(s.delaySeconds))
      .filter(notEmpty);
    let games = splitGames(pgns.join('\n\n'));
    games = filterGames(games, ctx.query.round);
    const slice = ctx.query.slice;
    if (slice) {
      const parts = slice.split('-').map((x: string) => parseInt(x));
      if (parts[1]) games = games.slice(parts[0] - 1, parts[1]);
      else games = games.slice(0, parts[0]);
    }
    if (notEmpty(ctx.query.roundbase)) {
      games = chess24Rounds(games, ctx.query.roundbase);
    }
    let pgn = await replace(games.join('\n\n'));

    if (ctx.query.shredder === '1') {
      pgn = toShredder(pgn);
    }

    ctx.body = pgn;
    ctx.status = 200;
    console.info(`GET: ${ctx.path} -> 200, length: ${pgn.length}`);
  });

  app.use(router.routes()).use(router.allowedMethods());
  app.listen(publicPort, publicIP);

  await z.users.me.subscriptions.add({
    subscriptions: JSON.stringify([{ name: zulipStream }]),
  });

  const q = await z.queues.register({ event_types: ['message'] });

  await zulipMessageLoop(z, q.queue_id, zulipHandler);
})();
