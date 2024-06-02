
# Attaching an IAM Role to Single / Multiple IAM User? Users in AWS

##### Let's take a scenario where Naveen, a user with full admin-level access to an AWS account, needs to attach an IAM role to an existing IAM user, sandeep_komal, who currently has no access to resources.


## Step-by-Step Instructions:

### Step 1: Create an IAM Role
##### Sign in to the AWS Management Console as Naveen.
##### Navigate to the IAM service.
##### In the left navigation pane, choose Roles and then Create role.
##### Select AWS Service and choose the service that will use this role (e.g., EC2, Lambda), or select Another AWS account if you need to allow cross-account access.
##### Select the use case for your role, and then choose Next: Permissions.
##### Attach policies that define the permissions for this role. Choose the necessary policy or create a custom one if required.
##### Choose Next: Tags to add tags (optional) and then Next: Review.
##### Enter a Role name and description, and then choose Create role.
![1 ](https://github.com/SandeepKomal/AWS/assets/99358567/c3e04af2-c566-4292-b58f-d66743c180ab)
![2](https://github.com/SandeepKomal/AWS/assets/99358567/5c3d1c74-e4bc-4f4c-bec9-4bf810f83d56)
![3](https://github.com/SandeepKomal/AWS/assets/99358567/9ade33e9-3637-4e92-b663-af84acf7c0bf)
![4](https://github.com/SandeepKomal/AWS/assets/99358567/b95e554d-cf18-49b4-ac56-596aef5e6d14)


### Step 2: Modify Trust Relationship for the Role
##### Go to the newly created role and select it.
##### Under the Trust relationships tab, choose Edit trust relationship.
##### Update the trust relationship to allow the IAM user komal to assume this role. It will look something like this:

```
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::ACCOUNT_ID:user/User"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}

```
![R1](https://github.com/SandeepKomal/AWS/assets/99358567/55843e52-3168-4dd0-9b82-9be80501ee92)
![R2](https://github.com/SandeepKomal/AWS/assets/99358567/45f8cbff-d607-4180-8240-726817baf16e)
![R3](https://github.com/SandeepKomal/AWS/assets/99358567/8ac15f5d-0b1f-4b3e-8490-d1075a013f5b)

Replace ACCOUNT_ID with your actual AWS account ID and user with Username.In this scenario Username is sandeep_komal

### Step 3: Attach a Policy to Komal to Assume the Role
##### Navigate to the IAM Users section and select the user komal.
##### Choose the Permissions tab and then Add inline policy.
##### Select the JSON tab and enter a policy that allows komal to assume the role. For example:

```
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": "arn:aws:iam::ACCOUNT_ID:role/ROLE_NAME"
    }
  ]
}

```
![US1](https://github.com/SandeepKomal/AWS/assets/99358567/41f613df-fad7-43bd-b325-0aab905460d0)
![us2](https://github.com/SandeepKomal/AWS/assets/99358567/b634cbbc-4801-4487-8afa-4cfca4ba3e2e)
![US3](https://github.com/SandeepKomal/AWS/assets/99358567/85fd3b8c-ed15-48a5-a493-a5c8db99890f)
![US4](https://github.com/SandeepKomal/AWS/assets/99358567/5cc86c30-64cf-48ff-a21d-a2c4d7d0ffb8)
![US5](https://github.com/SandeepKomal/AWS/assets/99358567/d8dfcb48-3a88-4790-9260-bbafb7049e42)
![US6](https://github.com/SandeepKomal/AWS/assets/99358567/0e3ec9f1-a2c8-4bcb-acd6-34ef3a91f865)

Replace ACCOUNT_ID with your actual AWS account ID and ROLE_NAME with the name of the role you created

### Step 4: Assuming the Role
##### Now, the komal user can assume the role with the following steps:

##### Install AWS CLI (if not already installed).

##### Configure AWS CLI with the komal user's credentials.

##### Assume the Role using the AWS CLI:

```
aws sts assume-role --role-arn arn:aws:iam::ACCOUNT_ID:role/EC2FullAccessRole --role-session-name KomalSession

```
This command will return temporary security credentials that komal can use to access EC2 resources.

## OR

### Step 4: Using the AWS Management Console to Assume a Role

#### 1. Sign in to the AWS Management Console as the IAM user komal.

#### Switch Role:

  In the top-right corner of the console, click on the account name (or the AWS account ID).
  Select Switch Role from the dropdown menu.
  
#### Enter Role Information:

     Account: Enter the AWS account ID (ACCOUNT_ID).
     Role: Enter the name of the role you want to assume (EC2FullAccessRole).
     Display Name: Enter a name for the role session to display in the console (e.g., EC2FullAccess).
     Color: Optionally, select a color to help you differentiate this role in the console.
     
#### Switch Role:

     Click the Switch Role button.

After switching roles, komal will have the permissions granted by the EC2FullAccessRole, which includes full access to EC2 resources.


### Detailed Steps with Screenshots

#### 1. Sign In to AWS Management Console:

        Go to AWS Management Console.
        Enter komal's username and password.

![L1](https://github.com/SandeepKomal/AWS/assets/99358567/3793fa2b-07ae-4731-a20e-40dcdc93e7e5)

        
#### Switch Role:

     Click on the account name (or AWS account ID) in the upper right corner.
     Select Switch Role from the dropdown menu.
![L2](https://github.com/SandeepKomal/AWS/assets/99358567/16f03cf2-efda-4485-8bd5-b2a04e93f5a1)


#### Enter Role Information:

  In the Account field, enter your AWS account ID.
  In the Role field, enter EC2FullAccessRole.
  In the Display Name field, enter a name for the session, such as EC2FullAccess.
  Optionally, choose a color for the role to help differentiate it.
![L3](https://github.com/SandeepKomal/AWS/assets/99358567/b34bbc08-c2e8-4398-8639-863b47a037a0)

#### Switch Role:

     Click the Switch Role button.
![L4](https://github.com/SandeepKomal/AWS/assets/99358567/298dc282-4a8f-4b90-9ede-998f974a0f18)


Now, komal will be using the EC2FullAccessRole and will have full access to EC2 resources as defined by the role's permissions.

