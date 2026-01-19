Steps to follow:
npm init -y
npm i playwright dotenv
npm i -D typescript ts-node @types/nodenpx playwright install
npx playwright install

// run LinkedIn to login and setup local cookies:
npm run auth:linkedin

// Next, run with your search criteria url from linkedin
npm run collect:linkedin -- --count=10 --url 'https://www.linkedin.com/jobs/search/?currentJobId=4253101367&distance=25.0&f_E=3%2C4&f_F=it%2Ceng&f_JT=F&f_T=9%2C39%2C25201%2C3172%2C1176&f_TPR=r86400&geoId=103644278&keywords=Software%20Engineer%20JavaScript&origin=JOBS_HOME_KEYWORD_HISTORY'


// after data/jobs.csv is populated, trigger the automation
npm run apply:batch for windows
npm run apply:batch:mac for mac