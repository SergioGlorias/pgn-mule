Merge, filter, tweak and expose PGN sources.

## Usage

```
# edit .env
yarn install
yarn start
```

In zulip

```
add <name> <source-url> <update-freq-seconds> <delay-seconds>
list
remove <name>
addMany 1,2,3,4,5,6,7 <name>{} <url>-{}.pgn <update-freq-seconds> <delay-seconds>
addReplacement from->to
listReplacements
delReplacement 0
```

## QueryString Options:

Note that the first option must start with `?`, and the later ones with `&`.

Examples:

- `url.com/foo?round=1`
- `url.com/foo?round=1&onlyTopBoards=20&shredder=1`
- `url.com/foo?onlyTopBoards=20&round=1`

In the examples below we'll only show `&`. Replace with `?` if it's the first option.

### shredder

For a given url, add in: `&shredder=1` which will convert X-Fen to Shredder-Fen

### round

Add in: `&round=4` to filter games with the `Round` PGN tag equal to `4` or starting with `4.`

### slice

Extract a slice of the games. Both sides are inclusive.

- `&slice=1-20` only keep the first 20 boards, and drop the other ones.
- `&slice=1-1` only keep the first board, and drop the other ones.
- `&slice=20-50` only keep the boards 20 to 50, and drop the other ones.
- `&slice=50-999` only keep the boards 50 to the last one.

The slicing happens **after** the `&round=` filtering.
Note that if you reduce the number of boards, after having already fetched them, then you must delete manually the extra chapters.
So be sure to have it `slice` set right from the beginning.

## Custom Round Tags

Add in: `&roundbase=1.{}` and the games will have their 1.{}
replaced with 1.1, 1.2, 1.3 ...

## Deploy

```sh
yarn build; rsync -av build node_modules root@radio.lichess.ovh:/home/zulip-pgn-mule/; ssh root@radio.lichess.ovh "systemctl restart zulip-pgn-mule"
```
