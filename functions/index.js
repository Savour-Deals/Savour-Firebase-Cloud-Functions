//DEPLOYING???
//  firebase use [savourtest or savourprod]


const fetch = require("isomorphic-fetch");
//firebase deploy --only functions
// The Cloud Functions for Firebase SDK to create Cloud Functions and setup triggers.
const functions = require('firebase-functions');
const geofire = require('geofire');

const onesignal_app_id = functions.config().keys.onesignal_app_id;
const onesignal_key = functions.config().keys.onesignal;


var moment = require("moment-timezone");


// The Firebase Admin SDK to access the Firebase Realtime Database.
const admin = require('firebase-admin');
admin.initializeApp();


//Create and delete account functions
exports.incrementUserCount = functions.database.ref('Users/{userId}').onCreate(() => {
  return admin.database().ref('appData/user_count').transaction(userCount => (userCount || 0) + 1);
});

exports.decrementUserCount = functions.database.ref('Users/{userId}').onDelete(() => {
  return admin.database().ref('appData/user_count').transaction(userCount => (userCount || 0) - 1);
});

exports.incrementVendorCount = functions.database.ref('VendorAccounts/{userId}').onCreate(() => {
  return admin.database().ref('appData/vendor_count').transaction(userCount => (userCount || 0) + 1);
});

exports.decrementVendorAccount = functions.database.ref('VendorAccounts/{userId}').onDelete(() => {
  return admin.database().ref('appData/user_count').transaction(userCount => (userCount || 0) - 1);
});

exports.signup = functions.auth.user().onCreate((user) => {
  user_ref = admin.database().ref('Users/').child(user.uid);
  user_ref.child('email').set(user.email);
  user_ref.child('full_name').set(user.displayName); 
  return 0;
});

exports.dealCreated = functions.database.ref('Deals/{dealId}').onCreate((snapshot, context)=> {
  const dealKey = snapshot.key;
  const deal = snapshot.val();
  var sendtime;
  var locationFilter;
  var fargoLatLong = [46.8772, -96.7898];
  var minneapolisLatLong = [44.9778, -93.2650];

  var geoFire = new geofire.GeoFire(admin.database().ref('/Vendors_Location'));

  //find out if we should send this to minneapolis or Fargo users
  geoFire.get(deal.vendor_id).then(function(location) {
    if (location === null) {
      //shouldnt see this?
      console.log("Provided key is not in GeoFire");
    }
    else {
      console.log("Provided key has a location of " + location);

      const nowunix_plus5 = moment().unix()+300;//5min in future for 
      if (nowunix_plus5 > deal.start_time){//deal is set to have already started. set notification for in the future 
        sendtime = moment(nowunix_plus5*1000).format("YYYY-MM-DD HH:mm:ss zZ");
      }else{//deal is scheduled to start in the future, set notification for when the deal starts
        sendtime = moment(deal.start_time*1000).format("YYYY-MM-DD HH:mm:ss zZ");
      }
      if(geofire.GeoFire.distance(location,minneapolisLatLong) > geofire.GeoFire.distance(location,fargoLatLong)){
        locationFilter = ["Fargo"];
      }else{
        locationFilter = ["Minneapolis"];
      }
      console.log(dealKey, sendtime);
      var message = { 
        app_id: onesignal_app_id,
        content_available: true,
        headings: {"en": deal.vendor_name + " just posted a new deal!"},
        contents: {"en": deal.deal_description},
        ios_attachments: {"id":deal.photo},
        big_picture: deal.photo,
        data: {"deal": dealKey},
        send_after: sendtime,
        included_segments: locationFilter,
      };
      console.log("Message:");
      console.log(message);

      var headers = {
        "Content-Type": "application/json; charset=utf-8",
        "Authorization": "Basic " + onesignal_key
      };
      
      var options = {
        host: "onesignal.com",
        port: 443,
        path: "/api/v1/notifications",
        method: "POST",
        headers: headers
      };
      
      var https = require('https');
      var req = https.  request(options, function(res) {  
        res.on('data', function(data) {
          console.log("Response:");
          console.log(JSON.parse(data));
        });
      });
      
      req.on('error', function(e) {
        console.log("ERROR:");
        console.log(e);
      });
      
      req.write(JSON.stringify(message));
      req.end();
    }
  }, function(error) {
    console.log("Error: " + error);
  });
  
  return 0;
});

exports.deleteAccount = functions.auth.user().onDelete((user) => {
  admin.database().ref('Users/').child(user.uid).remove();
  admin.database().ref('VendorAccounts/').child(user.uid).remove();
  return 0;
});

exports.updateVendor = functions.database.ref('Vendors/{newVendor}').onWrite((change, context) => {
  const before = change.before.val();
  var beforeAddress = "";
  if(before){
    beforeAddress = before.address;
  }
  const after = change.after.val();
  var geoFire = new geofire.GeoFire(admin.database().ref('/Vendors_Location'));
  if (change.after.val().address){
    if (beforeAddress != after.address){
      let url ="https://maps.googleapis.com/maps/api/geocode/json?address=" + encodeURIComponent(after.address) + "&key=AIzaSyAehSHrFZDjtzjhqRAg3j-PvJKTqv3P9Wg";
      console.log(url); 
      //Put vendor into geofire
      return fetch(url).then(result => result.json()).then(data => {
        if (data["results"][0]["geometry"]){
          var loc = data["results"][0]["geometry"]["location"];
          return geoFire.set(change.after.key, [loc["lat"], loc["lng"]]).then(function() {
            console.log(change.after.key + " has been added to GeoFire");
          }, function(error) {
            console.log(" Error adding " + change.after.key + ": " + error);
          });
        }
        else{
          console.log("Error geocoding address.");
          return 0;
        }
      });
    }else{
      return 0;
    }
  }else{
    return geoFire.remove(change.before.key).then(function() {
      console.log(change.before.key + " has been removed from GeoFire");
    }, function(error) {
      console.log("Error removing " + change.before.key + " : " + error);
    });
  }  
});

//User redeemed a regular deal
exports.dealRedeemed = functions.database.ref('Deals/{deal}/redeemed/{user}').onCreate((snapshot, context) => {
  const userID = context.params.user;
  const now = Math.floor(Date.now()/1000);
  if (userID == context.auth.uid){
    snapshot.ref.set(now);//make sure redemption time is consistent across apps
    return snapshot.ref.parent.parent.once("value").then(snap => {//get uid
      data = snap.val();
      console.log('Deal Redeemed: ', data.vendor_id, snap.key);
      //No longer charging through stripe
      // incrementStripe(data.vendor_id,1);
      incrementRedemptions(data.vendor_id,0);

      //increment savings
      user_ref = admin.database().ref('Users/').child(userID);
      user_ref.child('total_savings').transaction(function (current_value) {
        return (current_value || 0) + (data.value || 3);//assume $3 if value is not present
      });
      console.log("Pushing to global redemptions feed");
      //add to deal feed. On device, these can be used to recapture what deal was redeemed
      const pushedRef = admin.database().ref('/Redemptions').push({
        'timestamp': (now*-1),//store as inverse for firebase indexing
        'type' : "deal",
        'user_id': userID,
        'deal_id': snap.key,
        'description' : data.deal_description,
        "deal_photo" : data.photo,
        'vendor_id' : data.vendor_id
      });
      console.log("Pushing to friends redemptions feed");
      postToFriendsFeed(pushedRef.getKey(),userID,(now*-1));
      return 0;
    });
  }else{
    console.log(userID + " != " + context.auth.uid + ". Was the key just changed?");
    return 0;
  }

});

//user redeemed loyalty deal
exports.loyaltyRedeemed = functions.database.ref('Users/{user}/loyalty/{vendor}/redemptions/count').onUpdate((change, context) => {
  const now = Math.floor(Date.now()/1000);
  change.after.ref.parent.child("time").set(now);//make sure redemption time is consistent across apps
  const vendorID = context.params.vendor;
  const userID = context.params.user;
  if(change.after.val() < change.before.val()){//assume that the only way to lose points is by redeeming points
    console.log('Loyalty Redeemed: ', vendorID);
    //No longer charging through stripe
    // incrementStripe(vendorID,1);
    incrementRedemptions(vendorID,1);


  
    //add to deal feed. On device, these can be used to recapture what deal was redeemed
    return admin.database().ref("/Vendors").child(vendorID).once("value").then(snap => {
      if (snap.exists()){ //this really should exist if we are here. 
        console.log("Pushing to global redemptions feed");
        var data = snap.val();
        const pushedRef = admin.database().ref('/Redemptions').push({
          'timestamp': (now*-1),//store as inverse for firebase indexing
          'type' : "loyalty",
          'user_id': userID,
          'vendor_id': vendorID,
          'description' : data.loyalty.loyalty_deal,
          "vendor_photo" : data.photo
        });
        console.log("Pushing to friends redemptions feed");
        //increment savings
        user_ref = admin.database().ref('Users/').child(userID);
        user_ref.child('total_savings').transaction(function (current_value) {
          return (current_value || 0) + (data.loyalty.value || 5);//assume $5 if value is not present
        });
        //get our post's key so we can update friend's feeds
        postToFriendsFeed(pushedRef.getKey(),userID,(now*-1));
      }
      return 0;
    });
  }else{
    console.log('Loyalty count increased: ', vendorID);
    return admin.database().ref("/Vendors").child(vendorID).once("value").then(snap => {
      console.log("Pushing to global redemptions feed");
      const pushedRef = admin.database().ref('/Redemptions').push({
        'timestamp': (now*-1),//store as inverse for firebase indexing
        'type' : "loyalty_checkin",
        'user_id': userID,
        'vendor_id': vendorID,
        'description' : snap.val().loyalty.loyalty_deal,
        "vendor_photo" : snap.val().photo
      });
      console.log("Pushing to friends redemptions feed");
      //get our post's key so we can update friend's feeds
      postToFriendsFeed(pushedRef.getKey(),userID,(now*-1));
    });
  }
});

function postToFriendsFeed(postID,userID,timestamp){
  const usersRef = admin.database().ref('/Users');
  usersRef.child(userID).child('friends_list').once("value").then(snap => {
    if (snap.exists()){
      const friends = snap.val();
      Object.keys(friends).forEach(friend => {
        //add postID to friend's feed
        usersRef.child(friend).child("redemption_feed").child(postID).set(timestamp);
      });
    }
  });
}

function incrementRedemptions(vendor_id,deal_type){
  const vendorRef = admin.database().ref('/Vendors').child(vendor_id).child('period_redemptions');
  switch (deal_type) {
    case 1:
      //deal_type is loyalty
      vendorRef.child('loyalty').transaction(function (current_value) {
        return (current_value || 0) + 1;
      });
      break;
    default:
      //regular deal (deal_type=0) or deal type not given
      vendorRef.child('deals').transaction(function (current_value) {
        return (current_value || 0) + 1;
      });
      break;
  }
}

/*------------------------------------------------------------------------------------
STRIPE FUNCTIONS
------------------------------------------------------------------------------------*/
//No longer charging through stripe. Leave functions that may be called by old app verisons

//This function is left here for old app versions who still call this function. 
exports.incrementStripe = functions.https.onCall((data, response) => {
  console.log("incrmentStripe oncall removed");
});
