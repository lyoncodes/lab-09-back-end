'use strict';

// Dependencies

const express = require('express');
const cors = require('cors');
const superagent = require('superagent');
const pg = require('pg');

require('dotenv').config();

//Timeouts=================================
// Calling Date.now() returns the time in milliseconds since Jan 1 1970 00:00:00 UTC
// Multiplying an amount of milliseconds by 1000 achieves 1 second in computer time
// we will have a 15 second cache invalidation
// Darksky api has a request limit of 1000 hits a day
const timeouts = {
  weather: 15 * 1000 // 15 seconds
}
const PORT = process.env.PORT || 3000;

// App

const app = express();

app.use(cors());

//postgres
const client = new pg.Client(process.env.DATABASE_URL);
client.connect();
client.on('error', err => console.error(err));

// New SQL for location

app.get('/location', (request, response) => {
  let query = request.query.data;
  const SQL = 'SELECT * FROM locations WHERE search_query=$1';
  const values = [query];
  console.log(values);
  return client.query(SQL, values)

    .then(data => { //then if we have it, send it back
      if(data.rowCount){
        console.log('Location retrieved from database')
        response.status(200).send(data.rows[0]);
      } else {//otherwise, get it from google
        const URL = `https://maps.googleapis.com/maps/api/geocode/json?address=${query}&key=${process.env.GEOCODE_API_KEY}`;

        return superagent.get(URL)
          .then(result => {
            console.log('Location retrieved from Google')

            //then normalize it
            let location = new Location(result.body.results[0]);
            let SQL = `INSERT INTO locations (search_query, formatted_query, latitude, longitude) VALUES($1, $2, $3, $4) RETURNING id`;

            //store it in our DB
            return client.query(SQL, [query, location.formatted_query, location.latitude, location.longitude])
              .then((result) =>{
                location.id = result.rows[0].id;
                console.log ('location stored to database', result);
                //then send it back
                response.status(200).send(location);
              })
          })
      }
    })
    .catch(err => {
      console.log('location errror');
      console.error(err);
    })
})

// New SQL for weather

app.get('/weather', (request, response) => {
  let SQL = 'SELECT * FROM  weathers WHERE location_id=$1';
  let values = [request.query.data.id];
  client.query(SQL, values)

    .then(data =>{
      if(data.rowCount > 0){ //cache hit
        console.log('Weather retrieved from database')
        response.status(200).send(data.rows);
      } else { //cache miss
        const URL = `https://api.darksky.net/forecast/${process.env.DARKSKY_API_KEY}/${request.query.data.latitude},${request.query.data.longitude}`;

        return superagent.get(URL)
          .then( forecastData => {
            let weeklyForecast = forecastData.body.daily.data.map( oneDay => {
              let weatherObject = new Forecast(oneDay);
              SQL = `INSERT INTO weathers (time, forecast, created_at, location_id) VALUES($1, $2, $3, $4)`;
              let values = [weatherObject.time, weatherObject.forecast, Date.now(), request.query.data.id];
              client.query(SQL, values)

                .catch(err => {
                  console.log('=========================superagent weather errror====================')
                  console.error(err);
                })
              return weatherObject;
            })

            //normalize the data
            response.status(200).send(weeklyForecast);

          })
          .catch(err => {
            console.log('=========================weather error first one ====================')
            console.error(err);
          })
      }
    })
    .catch(err => {
      console.log('======================weather error second one =======================');
      console.error(err);
    })
})

// New SQL for Yelp

app.get('/yelp', (request, response) => {
  let SQL = 'SELECT * FROM restaurants WHERE location_id=$1';
  let values = [request.query.data.id];
  client.query(SQL, values)

    .then(data =>{
      if(data.rowCount > 0){ //cache hit
        console.log('Restaurants retrieved from database')
        response.status(200).send(data.rows);
      } else { //cache miss
        let yelpData = `https://api.yelp.com/v3/businesses/search?term=restaurants&latitude=${request.query.data.latitude}&longitude=${request.query.data.longitude}&limit=20`;

        return superagent.get(yelpData)
          // This .set() adds our API KEY
          .set('Authorization', `Bearer ${process.env.YELP_API_KEY}`)
          .then( foodData => {
            let restaurantData = foodData.body.businesses.map( business => {
              let restaurantObject = new Restaurant(business);
              let SQL = `INSERT INTO restaurants (name, image_url, price, rating, url, location_id) VALUES($1, $2, $3, $4, $5, $6)`;
              let values = [restaurantObject.name, restaurantObject.image_url, restaurantObject.price, restaurantObject.rating, restaurantObject.url, request.query.data.id];
              client.query(SQL, values);
              return(restaurantObject);
            })
            //normalize the data
            response.status(200).send(restaurantData);
          })

          .catch(err => {
            console.log('yelp errror');
            console.error(err);
          })
      }
    })
    .catch(err => {
      console.log('yelp errror');
      console.error(err);
    })
})

//New SQL for Movies

app.get('/movies', (request, response) => {
  let SQL = 'SELECT * FROM movies WHERE location_id=$1';
  let values = [request.query.data.id];
  client.query(SQL, values)
    .then(data => {
      if(data.rowCount > 0){ //cache hit
        // console.log('Movies retrieved from database')
        response.status(200).send(data.rows);
      } else { //cache miss
        let citySplice = request.query.data.formatted_query.split(',');
        // console.log(citySplice, 'cities');
        let movieData = `https://api.themoviedb.org/3/search/movie?api_key=${process.env.MOVIES_API_KEY}&query=${citySplice[0]},${citySplice[1]}`;
        console.log(movieData);
        return superagent.get(movieData)
          .then( filmData => {
            let films = filmData.body.results;//array of results
            // Sort Films by Popularity
            films.sort( function (a,b) {
              if( a.popularity > b.popularity) return -1;
              if( b.popularity > a.popularity) return 1;
              return 0;
            });
            //If # of films less than 20
            let numFilms = 20;
            if(films.length < 20) numFilms = films.length;
            //create film objects and push into array.
            let filmObject = films.map(film => {

              let formattedFilm = new Film(film);
              let SQL = `INSERT INTO movies (title, overview, average_votes, total_votes, image_url, popularity, released_on, location_id) VALUES($1, $2, $3, $4, $5, $6, $7, $8)`;
              let values = [formattedFilm.title, formattedFilm.overview, formattedFilm.average_votes, formattedFilm.total_votes, formattedFilm.image_url, formattedFilm.popularity, formattedFilm.released_on, request.query.data.id];
              // console.log(values);
              client.query(SQL, values)
                .catch(err=>{
                  console.log('error putting in DB', err)
                })
              return formattedFilm;
            })
            // console.log('FILM OBJECTS', filmObject)
            response.status(200).send(filmObject);
            //normalize the data
          })
          .catch(err=>console.log('shoudl be an error', err))
      }
    })
})

// app.get('/*', function(req, resp){
//   resp.status(500).send('Don\'t look behind the curtain');
// });

// Constructors

function Location (location, query) {
  this.search_query = query;
  this.formatted_query = location.formatted_address;
  this.latitude = location.geometry.location.lat;
  this.longitude = location.geometry.location.lng;
}

function Forecast (day) {
  this.forecast = day.summary;
  let date = new Date(day.time * 1000);
  this.time = date.toDateString();
  this.created_at = new Date.now();
}

function Restaurant (business) {
  this.name = business.name;
  this.image_url = business.image_url;
  this.price = business.price;
  this.rating = business.rating;
  this.url = business.url;
}

function Film (video) {
  this.title = video.title;
  this.overview = video.overview;
  this.average_votes = video.vote_average;
  this.total_votes = video.vote_count;
  this.image_url = 'https://image.tmdb.org/t/p/w200_and_h300_bestv2/' + video.poster_path;
  this.popularity = video.popularity;
  this.released_on = video.release_date;

}

// Checks

app.listen(PORT, () => {
  console.log('app is up on port 3000');
});