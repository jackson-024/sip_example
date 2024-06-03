var express = require("express");
var app = require("express")();
var http = require("http").createServer(app);
app.set("port", process.env.PORT || 4050);
var moment = require("moment");
bodyParser = require("body-parser");
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
var toolsM = require("./myActionSQL.js");

app.use(function (req, res, next) {
  var allowedOrigins = [
    "http://localhost:8080",
    "http://localhost:3000",
    "http://localhost:8088",
    "http://l92.168.16.28:1129",
    "http://197.248.186.94:1129",
    "http://197.248.186.94:1130",
    "http://192.168.16.28:1129",
    "http://192.168.16.28:8080",
    "http://197.248.186.94:12000",
  ];
  var origin = req.headers.origin;
  if (allowedOrigins.indexOf(origin) > -1) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.header("Access-Control-Allow-Headers", "X-Requested-With");
  res.header(
    "Access-Control-Allow-Methods",
    "GET",
    "OPTIONS",
    "POST",
    "PUT",
    "DELETE"
  );
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept"
  );
  res.header("Access-Control-Allow-Credentials", true);
  return next();
});

var push_sms_T = 0,
  synch_group_talk_T = 0,
  process_sms_T = 0,
  push_MO_T = 0,
  refresh_token = 0,
  robocall_cnt = 0,
  voicemail_cnt = 0,
  push_bulk_T = 0;

var ari = require("ari-client");
ari.connect("http://localhost:8088", "tuchumbe", "2Chumb3", clientLoaded);
var client_clone;

var {
  cust_status,
  get_topic,
  process_caller,
  process_dtmf,
  process_list,
  load_extensions,
  refresh_voicemail,
  process_SMS,
  check,
  robo_check,
  start_meeting,
  stop_meeting,
  reset_meeting,
  synch_group_talk,
  telegram_check,
} = require("./models");
var {
  send_sms,
  push_sms_bulk,
  log_agent,
  push_sms_MO,
  push_robocall,
  update_token,
  handle_mute,
  mute_bridge,
  update_agent_duration,
} = require("./call_out.js");

//Redis
const redis = require("redis");
var redis_client = redis.createClient();

redis_client.on("connect", function () {
  console.error("Redis Connected");
});
redis_client.on("error", (err) => {
  console.log("Redis Error: " + err);
});

//Global Variables
const answer_delay = 2000; //Milliseconds to delay

// handler for client being loaded
function clientLoaded(err, client) {
  client_clone = client;
  if (err) console.log(err);
  console.log("Client Loaded");

  //Create Sockets
  io = require("socket.io")(http, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
      allowedHeaders: ["Access-Control-Allow-Origin"],
    },
  });
  io.on("connection", (socket) => {
    console.log("Call_Conf Socket Connection");
    // client.on("disconnect", () => {
    //   console.log("Call_Conf Socket User Disconnected");
    // });
    socket.on("meeting_start", (meeting) => {
      start_meeting(meeting, redis_client, client);
    });

    socket.on("meeting_stop", (meeting) => {
      stop_meeting(meeting, redis_client, client);
    });

    socket.on("mute_host", (channel_id, state) => {
      mute_host(channel_id, state, client);
    });
  });

  // Flash everything on Redis
  redis_client.flushdb(function (err, succeeded) {
    console.log("Flash Redis", succeeded); // will be true if successfull
  });

  //Reset Group Talk if Any
  reset_meeting(redis_client, client);

  //Refresh MO Token
  update_token();

  //Trigger Process list
  var process_timer = setInterval(() => {
    process_list(redis_client, client);
  }, 15000);

  var reg_status = "";
  var mobile = "";
  var state = null;
  var new_state = null;

  // handler for StasisStart event
  function stasisStart(event, channel) {
    // ensure the channel is not a dialed channel
    var dialed = event.args[0] === "dialed";

    if (!dialed) {
      //Enable Talk Detection
      channel.on("ChannelTalkingStarted", function (event, channel) {
        ChannelTalkingStarted(event, channel);
        console.log("setiwa2");
      });

      channel.on("ChannelTalkingFinished", function (event, channel) {
        ChannelTalkingFinished(event, channel);
      });

      mobile = channel.caller.number;
      mobile = mobile.replace("+", "");
      if (mobile.length > 4) {
        if (mobile.substring(0, 3) != "254") {
          mobile = "254" + mobile;
        }
      }

      // innitiate Ring
      channel.ring(function (err) {});

      //Get registration Status
      cust_status(mobile, redis_client, channel).then((data) => {
        var reg_status = data[0].STATUS;
        var gender = data[0].gender;
        var chat_gender = data[0].chat_gender;
        var time_hold = data[0].time_hold;
        var day_night = data[0].day_night;
        var customer_id = data[0].id;

        if (data == "X") {
          reg_status = "X";
        }

        console.log("reg %s", reg_status);
        console.log("Answering channel %s", channel.name);
        setTimeout(() => {
          channel.answer(function (err) {
            if (err) console.log(err);
            //Create Playback Object
            var playback = client.Playback();

            // Register DTMF Events
            dtmfReceived(channel, playback);

            //Get the dialled cannel number or Extension Number
            client.channels.getChannelVar(
              { channelId: channel.id, variable: "CALLERID(dnid)" },
              function (err, called_no) {
                console.log(called_no.value, " called number");
                const called_number = called_no.value;

                process_caller(
                  mobile,
                  playback,
                  channel,
                  reg_status,
                  redis_client,
                  gender,
                  chat_gender,
                  time_hold,
                  day_night,
                  customer_id,
                  client,
                  called_number
                );
                
              }
            );
          });
        }, answer_delay);
      });
    }
  }

  // handler for ChannelStateChange event
  function channelStateChange(event, channel) {
    console.log("Channel %s is now: %s", channel.id, channel.state, mobile);
    if (channel.state == "Up") {
      //Register for DTMF
    }
  }

  // handler for StasisEnd event
  function stasisEnd(event, channel) {
    var agent_hangup = false;

    //  //Update Call Duration
    //  client.channels.getChannelVar(
    //   { channelId: obj["partner_channel"], variable: "CDR(billsec)" },
    //   function (err, duration) {
    //     if(err){
    //       console.log(`update_agent_duration Err: ${err}`);
    //     }else{
    //        update_agent_duration(obj["partner_channel"], duration.value);
    //     }

    //   }
    // );

    //Log Duration
    redis_client.hgetall(channel.id, function (err, obj) {
      if (err) {
        console.log(err);
      } else if (!obj) {
        //Object not found in Cache
        console.log("UpdateDuration Redis Key not found");
      } else {
        // Update state for Incoming
        var call_time = moment(obj["call_time"]);
        var duration = moment().diff(call_time, "seconds");
        update_agent_duration(channel.id, duration);
      }
    });

    redis_client.hgetall(channel.id, function (err, obj) {
      var hangup_mobile = event.channel.caller.number;
      hangup_mobile = hangup_mobile.replace("+", "");
      if (hangup_mobile.length > 4) {
        if (hangup_mobile.substring(0, 3) != "254") {
          hangup_mobile = "254" + hangup_mobile;
        }
      } else {
        //Agent Hangup
        agent_hangup = true;
      }
      if (hangup_mobile == "254709918111") {
        //Main Caller Hanged up causing System to Hangup on the Dialled Party
        log("stasisEnd:This is Trunk Number: Disconnected " + hangup_mobile);

        // return;
      }

      if (err) {
        console.log(err);
      } else if (!obj) {
        //Object not found in Cache
        console.log("stasisEnd:Redis Key not found for ", hangup_mobile);
      } else {
        //Get Previous state
        var state = obj["state"];
        var partner_id = obj["partner_id"];
        var is_caller = obj["is_caller"];
        var partner_channel = obj["partner_channel"];
        var playback_id = obj["playback_id"];
        var partner_playback = obj["partner_playback"];
        var service = obj["service"];
        var partner_mobile = obj["partner_mobile"];
        var caller_gender = obj["gender"];
        var partner_gender = obj["chat_gender"];
        var customer_id = obj["customer_id"];
        var own_mobile = obj["own_mobile"];
        var topic_id = obj["topic_id"];
        var bridge_id = obj["bridge_id"];

        console.log(`Hang up state ${JSON.stringify(obj)}`);
        var msg = "";
        if (state == "SR") {
          //New User dint complete registration
          msg =
            "Welcome to No strings attached. To participate you have to be over 18years." +
            "\nTerms and conditions apply.To Register kindly call 0900620240.";
        } else if (state == "C:J:ANS:YES") {
          /*Called Part received answered the call and accepted to Talk
            Send SMS to Hangup Party*/
          msg =
            `Thank you for using No Strings Attached. You were talking with partner ID ${partner_id}.` +
            `\nTo talk again dial 0900620240${partner_id} `;

          // send caller SMS
          var msg2 =
            `Thank you for using No Strings Attached. You were talking with partner ID ${customer_id}.` +
            `\nTo talk again dial 0900620240${customer_id} `;
          redis_client.hset(partner_channel, "state", "S");
          redis_client.hset(channel.id, "state", "S");

          send_sms(partner_mobile, msg2, "B");
          send_sms(own_mobile, msg, "B");
        } else if (state.substring(0, 4) == "conf") {
          //Emit to Front end
          var call_end = {
            channel: channel.id,
            topic_id: topic_id,
            bridge_id: bridge_id,
          };

          io.emit("call_end", call_end);

          msg = `Thank you for participating in today''s group talk.\nTo continue enjoying NSA service call 0900620240 Customer care 0709918888`;
          send_sms(own_mobile, msg, "B");
        }

        console.log(JSON.stringify(obj), " Hangup details");

        if (is_caller == "Y") {
          //Hangup Partner ID
          client.channels.hangup(
            { channelId: partner_channel },
            function (err) {
              console.log("Disconnecting partner");
            }
          );
        } else if (is_caller == "N") {
          //Return Partner to main Menu
          redis_client.hset(partner_channel, "state", "S");
          var sound = [
            "sound:/var/lib/asterisk/sounds/custom/tuchumbe/PATNERDISCONNECTED",
            "sound:/var/lib/asterisk/sounds/custom/tuchumbe/MENUS_SUMMARY-8khz",
          ];

          client.channels.playWithId(
            {
              channelId: partner_channel,
              media: sound,
              playbackId: partner_playback,
            },
            function (err, playback) {
              console.log("Return partner N to main menu");
            }
          );
        } else if (is_caller == "YY") {
          //Return Partner to main Menu

          redis_client.hset(partner_channel, "state", "S");
          var sound = [
            "sound:/var/lib/asterisk/sounds/custom/tuchumbe/PATNERDISCONNECTED",
            "sound:/var/lib/asterisk/sounds/custom/tuchumbe/MENUS_SUMMARY-8khz",
          ];

          client.channels.playWithId(
            {
              channelId: partner_channel,
              media: sound,
              playbackId: partner_playback,
            },
            function (err, playback) {
              console.log("Return partner YY to main menu");
            }
          );
        }

        //Hangup a call initiated by Agent
        if (agent_hangup) {
          log_agent(
            hangup_mobile,
            "HANGUP",
            `HANGUP ON -> Partner ID ${partner_id} : ${partner_mobile}`,
            `${caller_gender} ->  ${partner_gender} : ${service}`,
            customer_id,
            partner_mobile,
            channel.id
          );
        }
      }
    });

    //Clear redis key after 10 sec
    setTimeout(() => {
      redis_client.del(channel.id, (err, reply) => {
        if (err) console.log(err);
        console.log(
          "Channel %s just left our application. Keys Deleted after 10 sec = %s",
          channel.name,
          reply
        );
      });
    }, 10000);

    //Clear Channel from Lists
    redis_client.lrem("male_list", 0, channel.id, function (err, data) {
      console.log("Hangup Deleted from male_list " + data);
    });

    redis_client.lrem("female_list", 0, channel.id, function (err, data) {
      console.log("Hangup Deleted from female_list " + data);
    });

    redis_client.lrem("male_male_list", 0, channel.id, function (err, data) {
      console.log("Hangup Deleted from male_male_list " + data);
    });

    redis_client.lrem(
      "female_female_list",
      0,
      channel.id,
      function (err, data) {
        console.log("Hangup Deleted from female_female_list " + data);
      }
    );
  }

  //Handler Talk detect Start
  function ChannelTalkingStarted(event, channel) {
    console.log(channel.id, " is talking  ", event);
    io.emit("ChannelTalkingStarted", event);
  }

  //Handler Talk detect Stop
  function ChannelTalkingFinished(event, channel) {
    console.log(channel.id, " finished talking  ", event);
    io.emit("ChannelTalkingFinished", event);
  }

  //Handler for DTMF events
  function dtmfReceived(channel, playback) {
    //Subscribe to DTMF
    channel.on("ChannelDtmfReceived", function (event, channel) {
      //stop Playback

      if (playback.id) {
        playback.stop(function (err) {
          if (err) {
            console.log("dtmfReceived: ", err);
          }
        });
      }

      //Digit Pressed
      var digit = parseInt(event.digit);
      var dtmf_mobile = channel.caller.number;
      dtmf_mobile = dtmf_mobile.replace("+", "");
      if (dtmf_mobile.length > 4) {
        if (dtmf_mobile.substring(0, 3) != "254") {
          dtmf_mobile = "254" + dtmf_mobile;
        }
      }

      if (dtmf_mobile == "254anonymous") {
        //Anonymous Call

        var sound = ["sound:privacy-incorrect"];
        channel.play(
          {
            media: sound,
          },
          playback,
          (err) => {
            if (err) {
              console.log(err);
            }
          }
        );
      } else {
        redis_client.hgetall(channel.id, function (err, obj) {
          if (err) {
            console.log("dtmfReceived", err);
          } else if (!obj) {
            //Object not found in Cache
            console.log("dtmfReceived:Redis Key not found");
          } else {
            // //Get Previous state
            state = obj["state"];
            caller_gender = obj["gender"];
            var customer_id = obj["customer_id"];

            //Collecting Data
            if (state.includes("=")) {
              console.log("waiting zone " + digit);
              redis_client.hset(channel.id, "state", state + digit);
              if (isNaN(digit)) {
                console.log("completed " + state);
              } else {
                return;
              }
            }

            //Update State
            new_state = state + ":" + digit;

            process_dtmf(
              channel,
              new_state,
              digit,
              playback,
              redis_client,
              client,
              dtmf_mobile,
              state,
              caller_gender,
              customer_id
            );
          }
        });
      }

      //Get channel info from Redis Cache
    });
  }

  client.on("StasisEnd", stasisEnd);
  client.on("StasisStart", stasisStart);
  client.on("ChannelStateChange", channelStateChange);

  load_extensions(redis_client);
  client.start((apps = "tuchumbe"));

  app.post("/handle_mute", (req, res) => {
    handle_mute(res, client, req.body.channel_id, req.body.state);
  });

  app.post("/mute_bridge", (req, res) => {
    mute_bridge(res, client);
  });
} //======Client Loaded End=====

app.get("/", function (req, res) {
  res.send("Hello GET");
  console.log(req.rawBody);
});

app.post("/sms", function (req, res) {
  var msg = "";
  var mobile = "";
  var link_id = "";
  var offer_code = "";
  var reference_id = "";
  var trans_id = "";
  var time_stamp = req.body.requestTimeStamp;

  for (let i = 0; i < req.body.requestParam.data.length; i++) {
    var name = req.body.requestParam.data[i].name;
    var value = req.body.requestParam.data[i].value;
    if (name == "LinkId") {
      link_id = value;
    } else if (name == "OfferCode") {
      offer_code = value;
    } else if (name == "RefernceId") {
      reference_id = value;
    } else if (name == "ClientTransactionId") {
      trans_id = value;
    } else if (name == "USER_DATA") {
      msg = value;
    } else if (name == "Msisdn") {
      mobile = value;
    }
  }

  // log incoming

  var sql = `INSERT INTO incoming ( mobile, msg, link_id, offer_code, reference_id,
     trans_id, time_stamp, in_date) values ('${mobile}','${msg}','${link_id}','${offer_code}', 
     '${reference_id}','${trans_id}','${time_stamp}',now())`;

  toolsM.actionQry(sql, function (err, data) {
    if (err) {
      console.log("Log_SMS:ERROR : ", err);
      return;
    } else {
      console.log("Incoming SMS ...." + mobile);
    }
  }); //actionQry

  console.log(msg, mobile, link_id, offer_code, reference_id, trans_id);
  res.status(200).end();
}); //==Send Gateway========

app.post("/dlr", function (req, res) {
  // rep_msg = req.body.msg;
  // mobile = req.body.mobile;
  // source = req.body.source;
  // ticket_id = req.body.ticket_id;
  // acc_id = req.body.acc_id;
  // msg_id = req.body.msg_id;
  // category = req.body.category;
  // cashier_id = req.body.cashier_id;

  console.log("SMS= " + req.body);
  res.status(200).end();
}); //==Delivery Receipts========

app.post("/login", (req, res) => {
  check(res, req.body.user, req.body.pass, req.body.tp_id);
});

app.post("/login_robocall", (req, res) => {
  robo_check(res, req.body.user, req.body.pass);
});

app.post("/login_telegram", (req, res) => {
  var ip = req.headers["x-forwarded-for"] || req.connection.remoteAddress;
  console.log("IP", ip);
  telegram_check(res, req.body.user, req.body.pass);
});

app.post("/topic", (req, res) => {
  get_topic(res, req.body.user_id);
});

app.get("/nsa_dial", (req, res) => {
  console.log("mato");
  res.writeHead(302, {
    Location: "tel:0900620240",
    //add other headers here...
  });
  res.end();
});

function my_Timers() {
  push_sms_T++;
  process_sms_T++;
  push_MO_T++;
  refresh_token++;
  push_bulk_T++;
  synch_group_talk_T++;
  robocall_cnt++;
  voicemail_cnt++;

  if (push_sms_T >= 10) {
    push_sms_T = 0;
    push_sms_bulk();
  }

  if (push_bulk_T >= 10) {
    push_bulk_T = 0;
    // push_sms_bulk_blast();
  }

  if (process_sms_T >= 5) {
    process_sms_T = 0;
    process_SMS();
  }

  if (push_MO_T >= 10) {
    push_MO_T = 0;
    push_sms_MO();
  }

  if (refresh_token >= 50) {
    refresh_token = 0;
    update_token();
  }

  if (synch_group_talk_T >= 10) {
    synch_group_talk_T = 0;
    synch_group_talk(redis_client, client_clone);
  }

  if (robocall_cnt >= 10) {
    robocall_cnt = 0;
    push_robocall(client_clone, redis_client);
  }

  if (voicemail_cnt >= 10) {
    voicemail_cnt = 0;
    refresh_voicemail(redis_client);
  }
}

var server = http.listen(app.get("port"), "0.0.0.0", function () {
  var host = server.address().address;
  var port = server.address().port;
  console.log("Tuchumbe listening at http://%s:%s", host, port);
});

setInterval(() => {
  my_Timers();
}, 1000);
