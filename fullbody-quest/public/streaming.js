function pusher(content) {
    const now = Date.now();

    fetch('/pusher', {
        method: 'POST',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            time: now,
            content
        })
    })
}

function subscribe(cb) {
    const evtSource = new EventSource("/streaming");

    function getData(event) {
        try {
            return JSON.parse(event.data)
        } catch (e) {
            return {}
        }
    }

    evtSource.onmessage = (event) => {
        const data = getData(event);
        // console.log(`message:`, data);
    };

    evtSource.addEventListener('pose', function (event) {
        const data = getData(event);
        let lag = Date.now() - data.time;
        time.innerText = `${lag}ms`;
        // console.log('ping', event, data, lag);
        cb(data)
    });

    return () => {
        evtSource.close();
    }
}