
# Attaching an IAM Role to Single / Multiple IAM User? Users in AWS

##### Let's take a scenario where Naveen, a user with full admin-level access to an AWS account, needs to attach an IAM role to an existing IAM user, Komal, who currently has no access to resources.


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
Replace ACCOUNT_ID with your actual AWS account ID and user with Username.In this scenario Username is komal

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
  ![L1](https://github.com/SandeepKomal/AWS/assets/99358567/d2151a23-f1c2-44f2-bd99-a4c3a361636f)

        
#### Switch Role:

     Click on the account name (or AWS account ID) in the upper right corner.
     Select Switch Role from the dropdown menu.


#### Enter Role Information:

  In the Account field, enter your AWS account ID.
  In the Role field, enter EC2FullAccessRole.
  In the Display Name field, enter a name for the session, such as EC2FullAccess.
  Optionally, choose a color for the role to help differentiate it.

#### Switch Role:

     Click the Switch Role button.

Now, komal will be using the EC2FullAccessRole and will have full access to EC2 resources as defined by the role's permissions.

