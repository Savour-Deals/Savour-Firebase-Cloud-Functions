//DEPLOYING???
//  firebase use [savourtest or savourprod]

const fetch = require("isomorphic-fetch");
const promise = require('es6-promise').promise;
//promise.polyfill()
//firebase deploy --only functions
// The Cloud Functions for Firebase SDK to create Cloud Functions and setup triggers.
const functions = require('firebase-functions');
let GeoFire = require('geofire');
let GooglePlaces = require('node-googleplaces');

var stripe = require("stripe")(functions.config().keys.test_secret_key);
const endpointSecret = functions.config().keys.test_endpoint_secret;


// The Firebase Admin SDK to access the Firebase Realtime Database.
const admin = require('firebase-admin');
admin.initializeApp();

//Zomato: b64cc10fd2757db43d65d5af8d387daa

exports.updateVendor = functions.database.ref('Vendors/{newVendor}').onWrite((change, context) => {
  const before = change.before.val();
  var beforeAddress = "";
  if(before){
    beforeAddress = before.address;
  }
  const after = change.after.val();
  var geoFire = new GeoFire(admin.database().ref('/Vendors_Location'));
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

//Removed due to geocode QPS quota set by firebase
// exports.updateVendors = functions.https.onRequest((request, response) => {
//   const ref = admin.database().ref('/Vendors').once("value", function(dat){
//     //Refresh Geofire Data
//     dat.forEach(function(snap){
//       if (snap.val().place_id){
//         var address = snap.val().address;
//         let url = "https://maps.googleapis.com/maps/api/geocode/json?address=" + address + "&key=AIzaSyAehSHrFZDjtzjhqRAg3j-PvJKTqv3P9Wg"
//         console.log(url);
//         return fetch(url).then(result => result.json()).then(data => {
//           var loc = data["results"]["geometry"]["location"];
//           var geoFire = new GeoFire(admin.database().ref('/Vendors_Location'));
//           return geoFire.set(snap.key, [loc["lat"], loc["lng"]]).then(function() {
//             console.log(snap.key + " has been updated in GeoFire");
//           }, function(error) {
//             console.log(" Error updating " + snap.key + ": " + error);
//           });
//         });
//       }
//     })
//   }).then(result =>{
//     response.status(200).end();
//   })
// });

exports.incrementStripe = functions.https.onCall((data, response) => {
  const deal_type = data.deal_type || -1; //0: regular, 1: loyalty
  const vendor_id = data.vendor_id;
  const sub_id = data.subscription_id;
  var amount = 1;

  switch (deal_type) {
    //future: use deal_type to charge differently 
    case 1:
      //deal_type is loyalty
      amount = 1;
      break;
    default:
      //regular deal (deal_type=0) or deal type not given
      amount = 1;
      break;
  }
  const now = Math.floor(Date.now()/1000);
  if(sub_id!=""){
    return stripe.usageRecords.create(sub_id, {
      quantity: amount,
      timestamp: now,
      action: "increment"
    }).then(()=>{
      console.log("Stripe subscription usage incremented.")
      incrementRedemptions(vendor_id,deal_type);
      return { msg: "Success!"};
    }).catch(function(err) {
      console.log('incrementStripe: ' + err);
      throw new functions.https.HttpsError('aborted', err);
    });
  }else{//if no sub_id passed, assume call is correct that they shouldnt be charged
    console.log("No stripe subscription to update.")
    incrementRedemptions(vendor_id,deal_type);
    return { msg: "Success!"};
  }
});

function incrementRedemptions(vendor_id,deal_type){
  if (vendor_id!=""){
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
  }else{
    //App never supplied a vendor_id. May be old app version
    //Cant log redemptions :()
    console.log('vendor_id not provided. Could not increment period count.')
  }
}

exports.userActiveChanged = functions.database.ref('Users/{user}/stripe/active').onWrite((change) => {
  var sub_id = null;
  return change.after.ref.parent.parent.once("value").then(snap => {//get uid
    const uid = snap.key;
    console.log("User: " + uid);
    if (change.after.val()) {
      console.log("Setting sub ids and vendor locations");
      sub_id = snap.val().stripe.subscription_id;
    }else{
      console.log("Removing sub ids and vendors locations");
    }
    return uid;
  }).then(uid=>{
    const user_ref = admin.database().ref('/Users').child(uid);
    return user_ref.child('locations').once("value");
  }).then(function(locations){
    locations.forEach(location=>{
      const vendorRef = admin.database().ref('/Vendors').child(location.key);
      if (!change.after.val()) {
        //remove subscription ids for each vendor location
        //change address storage to make vendor visable again
        vendorRef.set({
          'address': null,
          'subscription_id': null,
          'inactive_address': location.val().address
        });
      }else{
        //put subscription id into all locations operated by vendor
        //change address storage to hide vendor
        vendorRef.set({
          'address': location.val().inactive_address,
          'subscription_id': sub_id,
          'inactive_address': null
        });
      }
    });
  }); 
});

exports.updateStripeSubscription = functions.https.onCall((data, context) => {
  const cust_id = data.cust_id;
  const stripeRef = admin.database().ref('/Users').child(context.auth.uid).child('stripe');
  if(data.sub_id){
    console.log("Cancelling user subscription: " + data.sub_id);
    stripe.subscriptions.update(data.sub_id, {cancel_at_period_end: true});
    stripeRef.child('cancelled_subscription_id').set(data.sub_id);
    stripeRef.child('active').set(false); //sets off database trigger to remove vendors
    stripeRef.child('stripe_subscription_id').remove();
    
  }else{
    return new Promise((resolve, reject) => {
      var sub_id = null;
      stripeRef.child('cancelled_subscription_id').once("value", function(data) {
        if (data.val()){
          sub_id = data.val();
        }
      }).then(()=>{
        if (sub_id){
          console.log("Re-subscribing user with sub_id: " + sub_id);
          stripe.subscriptions.update(sub_id, {cancel_at_period_end: false});
          stripeRef.child('cancelled_subscription_id').remove();
          stripeRef.child('active').set(true); //sets off database trigger to add vendors
          stripeRef.child('stripe_subscription_id').set(sub_id);
          resolve( { msg: "Success!", sub_id: sub_id});
        }else{
          console.log("No subscription found. Creating new one.");
          return stripe.subscriptions.create({
            customer: cust_id,
            //TODO: Modular plans for price scaling
            items: [{plan: 'plan_D9aRfjSRLJX3nw'}],
          }).then(function(subscription){
            console.log('Subscription id: ' + subscription.items.data[0].id);
            //Put sub id in user root. will be put in all vendor roots owned by user asynchronously
            stripeRef.child('subscription_id').set(subscription.items.data[0].id);//subscription item id for incrementing metered
            stripe_ref.child('stripe_subscription_id').set(subscription.id); //subscription id for cancelling and subscribing
            resolve( { msg: "Success!", sub_id: subscription.id});
          }).catch(function(err) {
            console.log('createStripe: ' + err);
            throw new functions.https.HttpsError('aborted', err);
          });
        }
      });
    });
  }
});

exports.createStripe = functions.https.onCall((data, context) => {
  const email = data.email;
  const src_id = data.src_id;
  console.log("Passed email: "+email);
  console.log("Passed source: "+ src_id);
  //const name = data.name
  if (!context.auth) {
    // Throwing an HttpsError so that the client gets the error details.
    throw new functions.https.HttpsError('unauthenticated', 'It appears you are not logged in.');
  }else if (email && src_id){
    //create a customer with the passed in card source
    return stripe.customers.create({
      email: email,
      source: src_id,
    }).then(function(customer){
      console.log('Customer id: ' + customer.id)
      //Put this customer id in user root
      const stripe_ref = admin.database().ref('/Users').child(context.auth.uid).child('stripe');
      stripe_ref.child('customer_id').set(customer.id);
      stripe_ref.child('current_source').set(src_id);
      return customer.id;
    }).then(function(cust_id){
      //subscribe customer to the metered billing plan.
      return stripe.subscriptions.create({
        customer: cust_id,
        //TODO: Modular plans for price scaling
        items: [{plan: 'plan_D9aRfjSRLJX3nw'}],
      })
    }).then(function(subscription){
      const stripe_ref = admin.database().ref('/Users').child(context.auth.uid).child('stripe');
      console.log('Subscription id: ' + subscription.items.data[0].id);
      //Put sub id in user root. will be put in all vendor roots owned by user asynchronously
      stripe_ref.child('active').set(true);
      stripe_ref.child('subscription_id').set(subscription.items.data[0].id); //subscription item id for incrementing metered
      stripe_ref.child('stripe_subscription_id').set(subscription.id); //subscription id for cancelling and subscribing
      return { msg: "Success!"};
    }).catch(function(err) {
      console.log('createStripe: ' + err);
      throw new functions.https.HttpsError('aborted', err);
    });
  }
});

exports.attachCardStripe = functions.https.onCall((data, context) => {
  const cust_id = data.cust_id;
  const src_id = data.src_id;
  return stripe.customers.createSource(cust_id, {
    source: src_id
  }).then(function(source) {
    console.log("Created new source for "+ cust_id);
    return setStripeSource(cust_id,src_id, context.auth.uid).then(result=>{
      return { msg: "Success!"};
    });
  }).catch(function(err) {
    console.log('attachCardStripe: ' + err);
    throw new functions.https.HttpsError('aborted', err);
  });
});

exports.changeStripeSource = functions.https.onCall((data, context) => {
  const cust_id = data.cust_id;
  const src_id = data.src_id;
  return setStripeSource(cust_id,src_id,context.auth.uid).then(result=>{
    return { msg: "Success!"};
  }).catch(err=>{
    console.log('changeStripeSource: ' + err);
    throw new functions.https.HttpsError('aborted', err);
  });
});

function setStripeSource(cust_id, src_id, uid) {
  return stripe.customers.update(cust_id, {
    default_source: src_id
  }).then(function(customer){
    if (customer){
      const stripe_ref = admin.database().ref('/Users').child(uid).child('stripe');
      stripe_ref.child('current_source').set(src_id);
      return { msg: "Success!"};
    }
  }).catch(function(err) {
    console.log('setStripeSource: ' + err);
    throw new functions.https.HttpsError('aborted', err);
  });
}

exports.getCustomerStripe = functions.https.onCall((data, context) => {
  const cust_id = data.cust_id;
  return stripe.customers.retrieve(cust_id).then(function(customer){
    console.log(customer);
    return {"customer":customer};
  }).catch(function(err) {
    console.log('getCustomerStripe: ' + err);
    throw new functions.https.HttpsError('aborted', err);
  });
});

exports.getInvoiceStripe = functions.https.onCall((data, context) => {
  const cust_id = data.cust_id;
  return stripe.invoices.retrieveUpcoming(cust_id).then(function(invoice){
    console.log(invoice);
    return {"invoice":invoice};
  }).catch(function(err) {
    console.log('getInvoiceStripe: ' + err);
    throw new functions.https.HttpsError('aborted', err);
  });
});

exports.events = functions.https.onRequest((request, response) => {
  let sig = request.headers["stripe-signature"];
  try {
    let event = stripe.webhooks.constructEvent(request.rawBody, sig, endpointSecret);
    return admin.database().ref('/events').push(event).then((snapshot) => {
      return response.json({ received: true, ref: snapshot.ref.toString() });
    }).catch((err) => {
      console.error(err);
      return response.status(500).end();
    });
  } catch (err) {
    return response.status(400).end();
  }
});




