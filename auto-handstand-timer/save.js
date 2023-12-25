// Saves recorded data to file
var textFile;
var makeTextFile = function (text) {
    var data = new Blob([text], { type: 'text/plain' });
    // revoke the object URL to avoid memory leaks.
    if (textFile !== null) {
        window.URL.revokeObjectURL(textFile);
    }

    textFile = window.URL.createObjectURL(data);
    return textFile;
};

function exportFile() {
    var text = JSON.stringify(handstandTracker.tracker[0]);

    var link = document.createElement('a');
    link.setAttribute('download', 'handstand.json');
    link.href = makeTextFile(text);
    document.body.appendChild(link);

    window.requestAnimationFrame(function () {
        var event = new MouseEvent('click');
        link.dispatchEvent(event);
        URL.revokeObjectURL(textFile);
        document.body.removeChild(link);
    });
}
