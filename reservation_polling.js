const fs = require("fs");
const readline = require("readline");
const got = require("got");

const { sendgrid_send_message } = require("./sendgrid_proxy.js");

const dataFilename = process.env.DEPLOY_STAGE ==  "PROD" ? "/home/pi/ikon-reservation-notifier/reservation_polling_data.txt" : "./reservation_polling_data.txt";
const newDataFilename = process.env.DEPLOY_STAGE ==  "PROD" ? "/home/pi/ikon-reservation-notifier/new_reservation_polling_data.txt" :  "./new_reservation_polling_data.txt";

const { load_puppeteer_page, get_page_token, build_cookie_str } = require("./puppeteer");
const { refresh_and_test_auth, get_ikon_resorts, get_ikon_reservation_dates } = require("./ikon_proxy");

async function main() {
    const file = fs.createReadStream(dataFilename);
    const new_file = fs.createWriteStream(newDataFilename);

    // Run browser page and cookies/token load once, then use those creds for every reservation data query
    let { error, error_message, data } = await refresh_and_test_auth();
    if (error) {
        console.error("Err in initial auth setup, exiting");
        console.error(error_message);
        return;
    }

    console.log("Initial Ikon API established");
    ({ error, error_message, data } = await get_ikon_resorts());
    if (error) {
        console.error("GET ikon resorts failed.");
        console.error(error_message);
        return;
    }

    const resorts = data;
    console.log("Successfully retrieved and parsed Ikon resorts");

    let lineData = [];
    const rl = readline.createInterface({
        input: file,
        crlfDelay: Infinity
    });

    for await (const line of rl) {
        if (line.trim() == "") {
            continue;
        }

        lineData = line.split(",");

        // email, resort id, reservation date, current date
        const email = lineData[0];
        const resortIdStr = lineData[1];
        const desiredDate = parseInt(lineData[2], 10);
        const dateSaved = lineData[3];
        const resortId = parseInt(resortIdStr);
        const resort = resorts.find(x => x.id == resortId);

        let reservation_info = await get_ikon_reservation_dates(resortId);
        if (reservation_info.error) {
            let { error, error_message, data } = await refresh_and_test_auth();
            if (error) {
                console.error("Failed refreshing auth after failing reservation dates request:");
                console.error(reservation_info.error_message + "\n");
                console.error(error_message);
                return res.status(500);
            } else {
                // Try call again after re authing
                reservation_info = await get_ikon_reservation_dates(resort_id);
                if (reservation_info.error) {
                    console.error("Second error for reservation info even after reauthing");
                    console.error(reservation_info.error_message);
                    return res.status(500);
                }
            }
        }
        
        // Dates need to be zeroed out otherwise comparison fails
        const closed_dates = reservation_info.data[0].closed_dates.map(x => {
            const d = new Date(x + "Z");
            d.setUTCHours(0, 0, 0, 0);
            return d;
        });
        const unavailable_dates = reservation_info.data[0].unavailable_dates.map(x => {
            const d = new Date(x + "Z");
            d.setUTCHours(0, 0, 0, 0);
            return d;
        });

        // It should parse it as UTC but tack onthe Z to force it for all cases
        let chosen_date = new Date(desiredDate);
        chosen_date.setUTCHours(0, 0, 0, 0);

        if (closed_dates.find(x => x.getTime() == chosen_date.getTime())) {
            console.log(`Resort is closed on ${chosen_date.toISOString()}.`);
            new_file.write("\n" + line);
        } else if (unavailable_dates.find(x => x.getTime() == chosen_date.getTime())) {
            console.log(`Reservations still full on ${chosen_date.toISOString()} for resort ${resort.name}`);
            new_file.write("\n" + line);
        } else {
            const end_of_date = chosen_date.toISOString().indexOf('T');
            const pretty_date = chosen_date.toISOString().substr(0, end_of_date);

            const msg = {
                to: email,
                from: "ikonreservationnotifier@brianteam.dev",
                subject: "Your chosen Ikon resort has open reservations!",
                text: `The resort you have been monitoring for open reservations, ${resort == undefined ? resortIdStr : resort.name}, now has open spots for ${pretty_date}. This date notification will now be cleared, if you would like to set another one please visit ikonreservations.brianteam.dev again`
            };

            const email_success = sendgrid_send_message(msg);
            if (email_success) {
                console.log(`Sent email to ${email} for ${resort == undefined ? resortIdStr : resort.name} on ${chosen_date.toISOString()}`);
            } else {
                console.error(`Error sending notification email to ${email} for ${resort == undefined ? resortIdStr : resort.name} for ${chosen_date.toISOString()}!`);
            }
        }
    }

    new_file.end();

    // Move our new file without any available reservations over the old one to overwrite
    fs.renameSync(dataFilename, dataFilename + ".bkp");
    fs.renameSync(newDataFilename, dataFilename);
    console.log("Moving old file to .bkp and renaming new file to be normal filename");
}

main()
	.catch(e => {
		console.error("Uncaught exception when running main()");
		console.error(e);
		process.exit(1);
	});
