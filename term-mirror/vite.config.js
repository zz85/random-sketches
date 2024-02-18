// vite.config.js

export default {
    root: './',
    plugins: [
    ],
    server: {
        proxy: {
            '/tmux': 'http://localhost:4000'
        }
    }
}
