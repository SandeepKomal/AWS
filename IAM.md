
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

