## Term Mirror

1. setup
```
npm i
```
2. setup tmux session
3. run tmux streamer

```
node tmux-stream.mjs
```

4. run vite
```
npm run vite
```

5. visit page
locahost/xterm.html

## standalone builds

Run builds ones

```
cp xterm.html index.html
npx vite build
```

now you can always run
```
node tmux-stream.mjs
```
without vite.