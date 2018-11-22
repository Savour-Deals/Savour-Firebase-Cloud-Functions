//DEPLOYING???
//  firebase use [savourtest or savourprod]

//TODO: Create less invocations
//TODO: handle stripe webhooks

const fetch = require("isomorphic-fetch");
const promise = require('es6-promise').promise;
//promise.polyfill()
//firebase deploy --only functions
// The Cloud Functions for Firebase SDK to create Cloud Functions and setup triggers.
const functions = require('firebase-functions');
let GeoFire = require('geofire');
let GooglePlaces = require('node-googleplaces');

var stripe = require("stripe")(functions.config().keys.secret_key);
const endpointSecret = functions.config().keys.endpoint_secret;


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

//User redeemed a regular deal
exports.dealRedeemed = functions.database.ref('Deals/{deal}/redeemed/{user}').onCreate((snapshot, context) => {
  return snapshot.ref.parent.parent.once("value").then(snap => {//get uid
    data = snap.val();
    console.log('Deal Redeemed: ', data.vendor_id, snap.key);
    incrementStripe(data.vendor_id,1);
    incrementRedemptions(data.vendor_id,0);
    return 0;
  });
});

//user redeemed loyalty deal
exports.loyaltyRedeemed = functions.database.ref('Users/{user}/loyalty/{vendor}/redemptions/count').onUpdate((change, context) => {
  console.log('Loyalty Redeemed: ', context.params.vendor);
  incrementStripe(context.params.vendor,1);
  incrementRedemptions(context.params.vendor,1);
  return 0;
});

function incrementStripe(vendor_id,amount){
  const now = Math.floor(Date.now()/1000);
  console.log(vendor_id + " :: " + now + " :: Creating record")
  return admin.database().ref('/Vendors').child(vendor_id).child('subscription_id').once("value").then(snap => {
    if (snap.exists()){
      return stripe.usageRecords.create(snap.val(), {
        quantity: amount,
        timestamp: now,
        action: "increment"
      }).then(()=>{
        console.log("Stripe subscription usage incremented.")
        return { msg: "Success!"};
      }).catch(function(err) {
        console.log('incrementStripe: ' + err);
        throw new functions.https.HttpsError('aborted', err);
      });
    }else{
      console.log("No stripe subscription to update.")
      return { msg: "Success!"};
    }
  });
};


exports.incrementStripe = functions.https.onCall((data, response) => {
  console.log("incrmentStripe oncall removed");
//   const deal_type = data.deal_type || -1; //0: regular, 1: loyalty
//   const vendor_id = data.vendor_id;
//   const sub_id = data.subscription_id;
//   var amount = 1;

//   switch (deal_type) {
//     //future: use deal_type to charge differently 
//     case 1:
//       //deal_type is loyalty
//       amount = 1;
//       break;
//     default:
//       //regular deal (deal_type=0) or deal type not given
//       amount = 1;
//       break;
//   }
//   const now = Math.floor(Date.now()/1000);
//   console.log(vendor_id + " :: " + now + " :: Creating record")
//   if(sub_id && sub_id != ""){
//     return stripe.usageRecords.create(sub_id, {
//       quantity: amount,
//       timestamp: now,
//       action: "increment"
//     }).then(()=>{
//       console.log("Stripe subscription usage incremented.")
//       incrementRedemptions(vendor_id,deal_type);
//       return { msg: "Success!"};
//     }).catch(function(err) {
//       console.log('incrementStripe: ' + err);
//       throw new functions.https.HttpsError('aborted', err);
//     });
//   }else{//if no sub_id passed, assume call is correct that they shouldnt be charged
//     console.log("No stripe subscription to update.")
//     incrementRedemptions(vendor_id,deal_type);
//     return { msg: "Success!"};
//   }
});

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
	if (sub_id){
		locations.forEach(location=>{
			const vendorRef = admin.database().ref('/Vendors').child(location.key);
			if (!change.after.val()) {
			  //remove subscription ids for each vendor location
			  //change address storage to make vendor visable again
			  vendorRef.child('address').once('value').then(snap => {
          vendorRef.update({
            'address': null,
            'subscription_id': null,
            'inactive_address': snap.val()
          });
			  });
			}else{
			  //put subscription id into all locations operated by vendor
			  //change address storage to hide vendor
			  vendorRef.child('inactive_address').once('value').then(snap => {
				vendorRef.update({
				  'address': snap.val(),
				  'subscription_id': sub_id,
				  'inactive_address': null
				});
			  });
			}
		});
	}
  }); 
});

exports.updateStripeSubscription = functions.https.onCall((data, context) => {
  const cust_id = data.cust_id;
  const stripeRef = admin.database().ref('/Users').child(context.auth.uid).child('stripe');
  if(data.sub_id){
    console.log("Cancelling user subscription: " + data.sub_id);
    stripe.subscriptions.update(data.sub_id, {cancel_at_period_end: true});
  }else{
    return new Promise((resolve, reject) => {
      var sub_id = null;
      stripeRef.once("value", function(data) {
        console.log(data.val());
        if (data.val()){
          if (data.val().cancelled_subscription_id){
            sub_id = data.val().cancelled_subscription_id;
          }else if (data.val().stripe_subscription_id){
            sub_id = data.val().stripe_subscription_id;
          }
        }
      }).then(()=>{
        if (sub_id){
          console.log("Re-subscribing user with sub_id: " + sub_id);
          stripe.subscriptions.update(sub_id, {cancel_at_period_end: false});
          resolve( { msg: "Success!", sub_id: sub_id});
        }else{
          console.log("No subscription found. Creating new one.");
          createStripeSubscription(cust_id).then(result=>{
            resolve( { msg: "Success!", sub_id: result.subscription.id});
          });
        }
      });
    });
  }
});

function createStripeSubscription(cust_id, coupon){
  return stripe.subscriptions.create({
    customer: cust_id,
    //TODO: Modular plans for price scaling
    coupon: coupon,
    items: [{plan: functions.config().subscriptions.plan_1dollar}],
  }).then(function(subscription){
    console.log('Subscription id: ' + subscription.items.data[0].id);
    return ( { subscription: subscription});
  }).catch(function(err) {
    console.log('createStripeSubscription: ' + err);
    throw new functions.https.HttpsError('aborted', err);
  });
}

exports.createStripe = functions.https.onCall((data, context) => {
  const email = data.email;
  const src_id = data.src_id;
  const coupon = data.coupon;
  console.log("Passed email: "+email);
  console.log("Passed source: "+ src_id);
  var stripe_ref = admin.database().ref('/Users').child(context.auth.uid).child('stripe');
  var cust_id;
  //const name = data.name
  if (!context.auth) {
    // Throwing an HttpsError so that the client gets the error details.
    throw new functions.https.HttpsError('unauthenticated', 'It appears you are not logged in.');
  }else if (email && src_id){
    //create a customer with the passed in card source
    return stripe.customers.create({
      email: email,
      source: src_id,
      metadata: {"firebase_id": context.auth.uid}
    }).then(function(customer){
      //Put this customer id in user root
      cust_id = customer.id;
      return createStripeSubscription(cust_id, coupon);
    }).then(function(result){
      //subscribe customer to the metered billing plan.
      stripe_ref.child('customer_id').set(cust_id);
      stripe_ref.child('current_source').set(src_id);
      stripe_ref.child('subscription_id').set(result.subscription.items.data[0].id);//subscription item id for incrementing metered
      stripe_ref.child('stripe_subscription_id').set(result.subscription.id); //subscription id for cancelling and subscribing
      stripe_ref.child('active').set(true);
      stripe_ref = admin.database().ref('/VendorAccounts').child(context.auth.uid).child('stripe');
      stripe_ref.child('customer_id').set(cust_id);
      stripe_ref.child('current_source').set(src_id);
      stripe_ref.child('subscription_id').set(result.subscription.items.data[0].id);//subscription item id for incrementing metered
      stripe_ref.child('stripe_subscription_id').set(result.subscription.id); //subscription id for cancelling and subscribing
      stripe_ref.child('active').set(true);
      return { msg: "Success!"};
    }).catch(function(err) {
      //Delete customer and let them try again
      stripe_ref.remove();
      stripe.customers.del(cust_id, function(err, confirmation) {});
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
      return { current_source: src_id};
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
  return getCustomer(cust_id);
});

function getCustomer(cust_id){
  return stripe.customers.retrieve(cust_id).then(function(customer){
    console.log(customer);
    return {"customer":customer};
  }).catch(function(err) {
    console.log('getCustomerStripe: ' + err);
    throw new functions.https.HttpsError('aborted', err);
  });
}

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

//retrieve stripe event and queue it in RTDB
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


exports.handleStripeEvent = functions.database.ref('events/{event}').onCreate((snapshot, context) => {
  var uid, subscription, cust_id;
  const event = snapshot.val();
  snapshot.ref.remove();
  console.log("handleStripeEvent: ", event.type);
  switch (event.type) {
    case "invoice.payment_succeeded":
      invoice = event.data.object; //event gives us subscription object
      cust_id = invoice.customer;
      //reset period counters
      return getCustomer(cust_id).then(result=>{
        if (result.customer.metadata){
          uid = result.customer.metadata.firebase_id;
          return uid;
        }else{
          throw 'Could not get customer uid';
        }
      }).then(uid=>{
        const user_ref = admin.database().ref('/Users').child(uid);
        return user_ref.child('locations').once("value");
      }).then(function(locations){
        locations.forEach(location=>{//for every location under this vendor, reset their period redemptions
          admin.database().ref('/Vendors').child(location.key).child('period_redemptions').remove();
        });
        return 0;
      }).catch(function(err) {
        console.log('ERROR::handleStripeEvent: invoice.payment_succeeded ' + err);
        return -1;
      });
      break;
    case "customer.deleted": //Account was deleted. delete stripe data.
      if (event.data.object.metadata){
        uid = event.data.object.metadata.firebase_id; //event gives us customer object
        var stripe_ref = admin.database().ref('/Users').child(uid).child('stripe');
        stripe_ref.remove();
        stripe_ref = admin.database().ref('/VendorAccounts').child(uid).child('stripe');
        stripe_ref.remove();
      }
      return 0;
      break;
    case "customer.created": //Account created. Add info to rtdb
      if (event.data.object){
        uid = event.data.object.metadata.firebase_id; //event gives us customer object
        console.log('uid: '+ uid);
      }
      return 0;
      break;
    case "customer.subscription.created": //Subscription created, add info to rtdb customer
      subscription = event.data.object; //event gives us subscription object
      cust_id = subscription.customer;
      return getCustomer(cust_id).then(result=>{
        if (result.customer.metadata){
          uid = result.customer.metadata.firebase_id;
          var stripe_ref = admin.database().ref('/Users').child(uid).child('stripe');
          stripe_ref.child('subscription_id').set(subscription.items.data[0].id);//subscription item id for incrementing metered
          stripe_ref.child('stripe_subscription_id').set(subscription.id); //subscription id for cancelling and subscribing
          stripe_ref.child('active').set(true);
          stripe_ref = admin.database().ref('/VendorAccounts').child(uid).child('stripe');
          stripe_ref.child('subscription_id').set(subscription.items.data[0].id);//subscription item id for incrementing metered
          stripe_ref.child('stripe_subscription_id').set(subscription.id); //subscription id for cancelling and subscribing
          stripe_ref.child('active').set(true);
        }
        return 0;
      });
      break;
    case "customer.subscription.updated": //Subscription updated. Interested in items updated or cancel_at_period_end
      subscription = event.data.object; //event gives us subscription object
      cust_id = subscription.customer;
      return getCustomer(cust_id).then(result=>{
        if (result.customer.metadata){
          uid = result.customer.metadata.firebase_id;
          var stripe_ref = admin.database().ref('/Users').child(uid).child('stripe');
          if (subscription.cancel_at_period_end){ //Subscription cancelling. 
            stripe_ref.child('cancelled_subscription_id').set(subscription.id);
            stripe_ref.child('stripe_subscription_id').remove();
            stripe_ref.child('active').set(false); //sets off database trigger to remove vendors
            stripe_ref = admin.database().ref('/VendorAccounts').child(uid).child('stripe');
            stripe_ref.child('cancelled_subscription_id').set(subscription.id);
            stripe_ref.child('stripe_subscription_id').remove();
            stripe_ref.child('active').set(false); //sets off database trigger to remove vendors
          }else{ //subscription items updated. Get new item id
            stripe_ref.child('subscription_id').set(subscription.items.data[0].id);//subscription item id for incrementing metered
            stripe_ref.child('stripe_subscription_id').set(subscription.id); //subscription id for cancelling and subscribing
            stripe_ref.child('cancelled_subscription_id').remove();
            stripe_ref.child('active').set(true);
            stripe_ref = admin.database().ref('/VendorAccounts').child(uid).child('stripe');
            stripe_ref.child('subscription_id').set(subscription.items.data[0].id);//subscription item id for incrementing metered
            stripe_ref.child('stripe_subscription_id').set(subscription.id); //subscription id for cancelling and subscribing
            stripe_ref.child('cancelled_subscription_id').remove();
            stripe_ref.child('active').set(true);
          }
          return 0;
        }
      });
      break;
    case "customer.subscription.deleted": //Subscription deleted. Delete left over sub_id
      subscription = event.data.object;
      cust_id = subscription.customer;
      return getCustomer(cust_id).then(result=>{
        if (result.customer.metadata){
          uid = result.customer.metadata.firebase_id;
          var stripe_ref = admin.database().ref('/Users').child(uid).child('stripe');
          stripe_ref.child('cancelled_subscription_id').remove();
          stripe_ref.child('stripe_subscription_id').remove();
          stripe_ref.child('active').set(false); //sets off database trigger to remove vendors
          stripe_ref = admin.database().ref('/VendorAccounts').child(uid).child('stripe');
          stripe_ref.child('cancelled_subscription_id').remove();
          stripe_ref.child('stripe_subscription_id').remove();
          stripe_ref.child('active').set(false); //sets off database trigger to remove vendors
        }
        return 0;
      });
      break;
    default:
      console.log("Stripe event not handled: " + event.type);
      return 0;
      break;
  }
});
