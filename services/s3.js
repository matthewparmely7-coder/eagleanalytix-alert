// Read ticket history from S3 (tm-daily / tm-special / vs-daily / vs-special).
// Not implemented yet. Cron already writes these files.

async function readTicketInfo(/* fileName, folder */) {
    return [];
}

module.exports = { readTicketInfo };
