# Media Semantics Character API Video Reference Implementation
Talking character video generator.

## Overview
This is the Video Reference Implementation for the [Media Semantics Character API](https://aws.amazon.com/marketplace/pp/B06ZY1VBFZ), a cloud-based API available on the Amazon AWS Marketplace.

## Requirements
You will need to be able to run Node.js, and you will need to obtain keys for the Character API and AWS Polly.

## Obtaining keys
Use the AWS Markeplace link above to add the Character API service to your AWS account. You will receive codes by email. You will be charged $0.007 per call to the 'animate' endpoint. Each videogen invocation will result in one or more 'animate' calls, but generally fewer than 2 or 3, depending on the character and the actions used. There are no monthly minimums. Charges will appear on your monthly AWS bill. AWS Polly calls are metered based on the length of the text to be spoken. 

## Installation

Install the sample, e.g. in the home directory:
```
cd ~  
git clone https://github.com/mediasemantics/videogen.git  
cd videogen
```

Install the required dependencies:
```
npm install
```

Modify the videogen.js file to add your Character API access credentials.

Replace 'xxxxxxxxxxxxxxxxxxxxxxxxx' with an API Key that you have created in the API dashboard.

Replace 'xxxxxxxxxxxxxxxxxxxx' and 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' with the values obtained when you created the 'polly' IAM user.

Save your changes.

## Usage

You can now generate a video:
```
$ node videogen MichelleHead SkyHigh250x200.jpg 250 200 0 0 NeuralJoanna "greet" "Hi there!" hello.mp4
```
Invoke videogen without arguments to learn what each argument does.

Output for the above invocation is available at https://www.mediasemantics.com/mp4/tutorial/hello.mp4.


## Going Further

Please see the [Introducing the Character API](https://www.mediasemantics.com/apitutorial.html) and [Generating Video](https://www.mediasemantics.com/apitutorial5.html) tutorials for more details on how videogen works, and how you can modify it to suit your needs.




